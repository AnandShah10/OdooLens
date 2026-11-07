import * as path from 'path';
import { Worker } from 'worker_threads';
import { extractOdooModels, PythonFileAnalysis } from './OdooModelExtractor';

/**
 * Optional worker-thread pool for Python parse+extract.
 *
 * Safety contract:
 * - On ANY worker failure (startup, WASM init, crash, timeout) the pool disables itself for
 *   the rest of the process and all subsequent work uses the main-thread `extractOdooModels`
 *   path — identical to pre-worker behaviour.
 * - Workers never share tree-sitter Tree handles; only JSON-serializable analyses cross the
 *   boundary, so a worker death cannot corrupt the host's parser state.
 * - Existing concurrent main-thread `mapPool` in OdooIndex still applies when workers are off.
 */

const MAX_WORKERS = 2;
const JOB_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (a: PythonFileAnalysis) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class ParseWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private pending = new Map<number, Pending>();
  private queue: Array<{
    id: number;
    filePath: string;
    source: string;
    module: string;
    extensionRoot: string;
    resolve: (a: PythonFileAnalysis) => void;
    reject: (e: Error) => void;
  }> = [];
  private nextId = 1;
  private disabled = false;
  private starting: Promise<void> | null = null;

  /** True when workers are unavailable; callers may skip trying. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  private workerScript(): string {
    // Compiled output: out/src/parser/python/parseWorkerEntry.js next to this file at runtime.
    return path.join(__dirname, 'parseWorkerEntry.js');
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers = [];
    this.idle = [];
    // Reject anything still waiting so callers fall back.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`parse worker disabled: ${reason}`));
    }
    this.pending.clear();
    for (const job of this.queue) {
      job.reject(new Error(`parse worker disabled: ${reason}`));
    }
    this.queue = [];
  }

  private async ensureStarted(extensionRoot: string): Promise<void> {
    if (this.disabled) return;
    if (this.workers.length > 0) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const script = this.workerScript();
        for (let i = 0; i < MAX_WORKERS; i++) {
          const worker = new Worker(script, {
            workerData: { extensionRoot },
          });
          worker.on('message', (msg: any) => {
            if (msg?.type === 'ready') return;
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            this.idle.push(worker);
            this.pump();
            if (msg.ok) pending.resolve(msg.analysis as PythonFileAnalysis);
            else pending.reject(new Error(msg.error ?? 'worker job failed'));
          });
          worker.on('error', (err) => {
            this.disable(String(err?.message ?? err));
          });
          worker.on('exit', (code) => {
            if (code !== 0 && !this.disabled) {
              this.disable(`worker exited with code ${code}`);
            }
          });
          this.workers.push(worker);
          this.idle.push(worker);
        }
      } catch (err: any) {
        this.disable(String(err?.message ?? err));
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
        // Remove from workers list; disable pool so we don't reuse a half-dead set.
        this.disable(`job ${job.id} timed out after ${JOB_TIMEOUT_MS}ms`);
        job.reject(new Error('parse worker job timed out'));
      }, JOB_TIMEOUT_MS);
      this.pending.set(job.id, { resolve: job.resolve, reject: job.reject, timer });
      worker.postMessage({
        id: job.id,
        filePath: job.filePath,
        source: job.source,
        module: job.module,
        extensionRoot: job.extensionRoot,
      });
    }
  }

  /**
   * Parse+extract on a worker, or reject if the pool is disabled / fails.
   * Callers should catch and fall back to main-thread extractOdooModels.
   */
  async extract(
    filePath: string,
    source: string,
    module: string,
    extensionRoot: string
  ): Promise<PythonFileAnalysis> {
    if (this.disabled) {
      throw new Error('parse worker pool disabled');
    }
    await this.ensureStarted(extensionRoot);
    if (this.disabled || this.workers.length === 0) {
      throw new Error('parse worker pool unavailable');
    }
    const id = this.nextId++;
    return new Promise<PythonFileAnalysis>((resolve, reject) => {
      this.queue.push({ id, filePath, source, module, extensionRoot, resolve, reject });
      this.pump();
    });
  }
}

const pool = new ParseWorkerPool();

/**
 * Preferred entry for indexing: try worker pool, fall back to main-thread extract.
 * Behavioural result is always a PythonFileAnalysis; only the execution context changes.
 */
export async function extractOdooModelsMaybeWorker(
  filePath: string,
  source: string,
  module: string,
  extensionRoot: string
): Promise<PythonFileAnalysis> {
  if (!pool.isDisabled) {
    try {
      return await pool.extract(filePath, source, module, extensionRoot);
    } catch {
      // Fall through to main thread — do not rethrow.
    }
  }
  return extractOdooModels(filePath, source, module, extensionRoot);
}
