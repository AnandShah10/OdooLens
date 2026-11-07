/**
 * Worker-thread entry for Python parse + Odoo extraction.
 * Runs in a dedicated thread so the extension host stays responsive.
 * Input/output are pure JSON-serializable values (no tree-sitter Tree handles cross the boundary).
 */
import { parentPort, workerData } from 'worker_threads';
import { extractOdooModels } from './OdooModelExtractor';

interface Job {
  id: number;
  filePath: string;
  source: string;
  module: string;
  extensionRoot: string;
}

async function handle(job: Job): Promise<void> {
  try {
    const analysis = await extractOdooModels(job.filePath, job.source, job.module, job.extensionRoot);
    parentPort?.postMessage({ id: job.id, ok: true, analysis });
  } catch (err: any) {
    parentPort?.postMessage({
      id: job.id,
      ok: false,
      error: String(err?.message ?? err),
    });
  }
}

parentPort?.on('message', (job: Job) => {
  void handle(job);
});

// Signal readiness (optional handshake for the pool)
parentPort?.postMessage({ type: 'ready' });

// workerData reserved for future static config
void workerData;
