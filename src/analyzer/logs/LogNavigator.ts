export interface ParsedLogError {
  exceptionType: string; // e.g. odoo.exceptions.ValidationError
  message: string;
  frames: TracebackFrame[];
  raw: string;
}

export interface TracebackFrame {
  file: string;
  line: number;
  functionName: string;
}

const TRACEBACK_HEADER = /^Traceback \(most recent call last\):/;
const FRAME_RE = /^\s*File "(.+?)", line (\d+), in (.+)$/;
const EXCEPTION_RE = /^([\w.]+(?:Error|Exception|Warning))\s*:\s*(.*)$/;

/**
 * Splits a raw Odoo server log (or a pasted traceback) into individual error occurrences.
 * Handles the standard Python traceback format Odoo emits, plus bare `odoo.exceptions.*` lines
 * without a preceding traceback (common in log-only output without full stack traces).
 */
export function parseOdooLog(logText: string): ParsedLogError[] {
  const lines = logText.split(/\r?\n/);
  const results: ParsedLogError[] = [];

  let i = 0;
  while (i < lines.length) {
    if (TRACEBACK_HEADER.test(lines[i])) {
      const frames: TracebackFrame[] = [];
      const startIdx = i;
      i++;
      while (i < lines.length) {
        const frameMatch = lines[i].match(FRAME_RE);
        if (frameMatch) {
          frames.push({ file: frameMatch[1], line: parseInt(frameMatch[2], 10), functionName: frameMatch[3] });
          i++;
          // Skip the source-line-echo that traceback printers usually emit next.
          if (i < lines.length && !FRAME_RE.test(lines[i]) && !EXCEPTION_RE.test(lines[i]) && lines[i].trim() !== '') {
            i++;
          }
          continue;
        }
        const excMatch = lines[i].match(EXCEPTION_RE);
        if (excMatch) {
          results.push({
            exceptionType: excMatch[1],
            message: excMatch[2],
            frames,
            raw: lines.slice(startIdx, i + 1).join('\n'),
          });
          i++;
          break;
        }
        if (lines[i].trim() === '') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Bare exception line without a full traceback above it.
    const bareMatch = lines[i].match(EXCEPTION_RE);
    if (bareMatch && /odoo\.exceptions/.test(lines[i])) {
      results.push({ exceptionType: bareMatch[1], message: bareMatch[2], frames: [], raw: lines[i] });
    }
    i++;
  }

  return results;
}

/** Groups parsed errors by their innermost (last) frame + exception type, for recurrence counts. */
export function aggregateRecurringErrors(errors: ParsedLogError[]): { key: string; count: number; sample: ParsedLogError }[] {
  const groups = new Map<string, { count: number; sample: ParsedLogError }>();
  for (const err of errors) {
    const lastFrame = err.frames[err.frames.length - 1];
    const key = lastFrame ? `${err.exceptionType}@${lastFrame.file}:${lastFrame.functionName}` : `${err.exceptionType}@${err.message}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { count: 1, sample: err });
  }
  return Array.from(groups.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);
}
