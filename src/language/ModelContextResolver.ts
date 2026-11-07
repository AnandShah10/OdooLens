import * as vscode from 'vscode';
import { OdooWorkspaceIndex } from '../index/OdooIndex';

export interface ResolvedContext {
  model: string;
  /** How confident we are that `model` is correct — surfaced to keep completions/hover honest. */
  confidence: 'high' | 'medium' | 'low';
}

const ENV_SUBSCRIPT_RE = /self\.env\[\s*(['"])([\w.]+)\1\s*\]\s*\.\s*$/;
const ENV_SUBSCRIPT_NO_DOT_RE = /self\.env\[\s*(['"])([\w.]+)\1\s*\]\s*$/;
const VAR_ASSIGN_ENV_RE = (varName: string) =>
  new RegExp(`\\b${escapeRe(varName)}\\s*=\\s*self\\.env\\[\\s*(['"])([\\w.]+)\\1\\s*\\]`);
const FOR_LOOP_RE = (varName: string) => new RegExp(`for\\s+${escapeRe(varName)}\\s+in\\s+(\\w+)\\b`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves the Odoo model that the expression immediately before `position` refers to.
 *
 * This is a documented static approximation, not full type inference (see ARCHITECTURE.md
 * "Language Feature Limitations"): it recognizes (a) `self.env['model.name'].`, (b) `self.`
 * within a method whose enclosing class contributes to a known model, and (c) a local variable
 * that was directly assigned from `self.env['model'].search/browse/create(...)` earlier in the
 * same file, including one level of `for x in y:` indirection. Anything beyond that (method
 * return-type inference, cross-file variable flow, `sudo()`/`with_context()` chains) is not
 * resolved and simply yields no completions rather than a guess.
 */
export function resolveModelContext(
  index: OdooWorkspaceIndex,
  document: vscode.TextDocument,
  position: vscode.Position
): ResolvedContext | null {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

  const envMatch = linePrefix.match(ENV_SUBSCRIPT_RE) ?? linePrefix.match(ENV_SUBSCRIPT_NO_DOT_RE);
  if (envMatch) {
    return { model: envMatch[2], confidence: 'high' };
  }

  const selfMatch = linePrefix.match(/\bself\s*\.\s*$/) || linePrefix.match(/\bself\s*$/);
  if (selfMatch) {
    const model = findEnclosingModel(index, document.fileName, position.line);
    if (model) return { model, confidence: 'high' };
  }

  const varMatch = linePrefix.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/) || linePrefix.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (varMatch) {
    const varName = varMatch[1];
    if (varName === 'self') return null; // already handled above
    const fullText = document.getText();
    const directAssign = fullText.match(VAR_ASSIGN_ENV_RE(varName));
    if (directAssign) {
      return { model: directAssign[2], confidence: 'medium' };
    }
    const forLoop = fullText.match(FOR_LOOP_RE(varName));
    if (forLoop) {
      const iterableName = forLoop[1];
      if (iterableName === 'self') {
        const model = findEnclosingModel(index, document.fileName, position.line);
        if (model) return { model, confidence: 'medium' };
      }
      const iterableAssign = fullText.match(VAR_ASSIGN_ENV_RE(iterableName));
      if (iterableAssign) return { model: iterableAssign[2], confidence: 'low' };
    }
  }

  return null;
}

function findEnclosingModel(index: OdooWorkspaceIndex, file: string, line: number): string | null {
  const analysis = index.pythonFiles.get(file);
  if (!analysis) return null;
  let best: { model: string; startLine: number } | null = null;
  for (const contribution of analysis.modelContributions) {
    if (contribution.location.startLine <= line && line <= contribution.location.endLine) {
      const model = contribution.name ?? contribution.inherit[0];
      if (model && (!best || contribution.location.startLine > best.startLine)) {
        best = { model, startLine: contribution.location.startLine };
      }
    }
  }
  return best?.model ?? null;
}
