import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { PythonFileAnalysis } from '../../parser/python/OdooModelExtractor';

export interface RuleContext {
  analysis: PythonFileAnalysis;
  source: string;
  enabledRules: Record<string, boolean>;
}

export interface PerformanceRule {
  id: string;
  description: string;
  helpUri?: string;
  run(ctx: RuleContext): OdooDiagnostic[];
}
