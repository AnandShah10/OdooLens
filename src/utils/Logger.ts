import * as vscode from 'vscode';

type Level = 'error' | 'warning' | 'information' | 'hint';

// Higher rank = more verbose. A message is printed when its own rank is <= the configured
// threshold's rank (i.e. "hint" only prints when the user asked for the most verbose setting).
const RANK: Record<Level, number> = { error: 0, warning: 1, information: 2, hint: 3 };

/**
 * Wraps the "OdooLens" output channel with level-gated logging, so
 * `odooIntelligence.logLevel` (declared in package.json but never read anywhere before this)
 * actually controls what gets printed. Default 'information' matches the previous unconditional
 * behavior for the messages that existed before this wrapper — setting it to 'error' silences
 * routine "indexed N modules" logging and keeps only real failures.
 */
export class Logger {
  constructor(private channel: vscode.OutputChannel) {}

  private threshold(): Level {
    return vscode.workspace.getConfiguration('odooIntelligence').get<Level>('logLevel', 'information');
  }

  private log(level: Level, message: string): void {
    if (RANK[level] <= RANK[this.threshold()]) {
      this.channel.appendLine(`[OdooLens] ${message}`);
    }
  }

  error(message: string): void {
    this.log('error', message);
  }
  warning(message: string): void {
    this.log('warning', message);
  }
  info(message: string): void {
    this.log('information', message);
  }
  hint(message: string): void {
    this.log('hint', message);
  }
}
