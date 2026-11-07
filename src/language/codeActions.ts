import * as vscode from 'vscode';

const ORM_LOOP_RULE_IDS = new Set(['search-in-loop', 'browse-in-loop', 'create-in-loop', 'write-in-loop', 'unlink-in-loop']);

const SUGGESTION_SNIPPETS: Record<string, string> = {
  'search-in-loop':
    '# Suggested batching pattern:\n# ids = partners.ids  # or however the loop variable is derived\n# batched = self.env[\'<model>\'].search([(\'<field>\', \'in\', ids)])\n# Then look up each partner\'s slice from `batched` instead of searching per iteration.',
  'browse-in-loop':
    '# Suggested batching pattern:\n# records = self.env[\'<model>\'].browse(all_ids)  # once, outside the loop\n# for record in records:\n#     ...',
  'create-in-loop':
    '# Suggested batching pattern:\n# vals_list = [ {...} for item in items ]\n# self.env[\'<model>\'].create(vals_list)  # one INSERT round-trip',
  'write-in-loop':
    '# Suggested batching pattern:\n# combined = self.env[\'<model>\'].browse(all_ids)  # or reduce with |=\n# combined.write({...})  # one UPDATE round-trip if the values are the same',
  'unlink-in-loop':
    '# Suggested batching pattern:\n# combined = self.env[\'<model>\'].browse(all_ids)\n# combined.unlink()  # one DELETE round-trip',
};

/**
 * Surfaces "Show suggested fix" CodeActions for OdooLens diagnostics. Per the spec's Quick
 * Fixes philosophy, this intentionally does NOT auto-rewrite ORM-loop code (semantics of the
 * batching transform depend on things static analysis can't safely verify — whether the loop
 * body has other side effects, whether results are consumed per-iteration, etc.). Instead it
 * inserts a clearly-marked suggestion comment above the flagged line for the developer to adapt
 * and then remove, and offers a "Learn more" action for anything with a help URI.
 */
export class OdooCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'OdooLens') continue;
      const ruleId = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
      if (typeof ruleId !== 'string') continue;

      if (ORM_LOOP_RULE_IDS.has(ruleId) && SUGGESTION_SNIPPETS[ruleId]) {
        const action = new vscode.CodeAction(`OdooLens: Show suggested fix for ${ruleId}`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        const lineStart = new vscode.Position(diagnostic.range.start.line, 0);
        const indent = document.lineAt(diagnostic.range.start.line).text.match(/^\s*/)?.[0] ?? '';
        const commentBlock = SUGGESTION_SNIPPETS[ruleId]
          .split('\n')
          .map((l) => indent + l)
          .join('\n');
        action.edit.insert(document.uri, lineStart, commentBlock + '\n');
        action.isPreferred = false; // Not auto-applied by default; the developer chooses it explicitly.
        actions.push(action);
      }

      const codeObj = diagnostic.code;
      if (typeof codeObj === 'object' && codeObj.target instanceof vscode.Uri) {
        const learnMore = new vscode.CodeAction(`OdooLens: Learn more about ${ruleId}`, vscode.CodeActionKind.QuickFix);
        learnMore.diagnostics = [diagnostic];
        learnMore.command = { command: 'vscode.open', title: 'Open documentation', arguments: [codeObj.target] };
        actions.push(learnMore);
      }
    }
    return actions;
  }
}
