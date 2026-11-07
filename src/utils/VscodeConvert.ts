import * as vscode from 'vscode';
import { OdooDiagnostic, SourceLocation, Confidence } from '../semantic/OdooTypes';

export function toRange(loc: SourceLocation): vscode.Range {
  return new vscode.Range(
    new vscode.Position(loc.startLine, loc.startCol),
    new vscode.Position(loc.endLine, loc.endCol)
  );
}

export function toLocation(loc: SourceLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.file(loc.file), toRange(loc));
}

function severityOf(sev: OdooDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (sev) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

function confidenceLabel(c: Confidence): string {
  return c === 'high' ? 'high confidence' : c === 'medium' ? 'medium confidence' : 'low confidence, verify manually';
}

export function toVscodeDiagnostic(d: OdooDiagnostic): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(toRange(d.location), `${d.message} [${confidenceLabel(d.confidence)}]`, severityOf(d.severity));
  diag.source = 'OdooLens';
  diag.code = d.ruleId;
  if (d.helpUri) {
    diag.code = { value: d.ruleId, target: vscode.Uri.parse(d.helpUri) };
  }
  return diag;
}
