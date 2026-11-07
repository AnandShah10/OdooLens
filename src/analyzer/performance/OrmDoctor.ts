import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { PythonFileAnalysis } from '../../parser/python/OdooModelExtractor';
import { PerformanceRule } from './PerformanceRule';
import { makeOrmCallInLoopRules } from './rules/OrmCallInLoopRule';
import { searchCountMisuseRule } from './rules/SearchCountMisuseRule';
import { repeatedEnvAccessRule } from './rules/RepeatedEnvAccessRule';
import { mappedInLoopRule } from './rules/MappedInLoopRule';
import { readInLoopRule } from './rules/ReadInLoopRule';
import { nestedOrmLoopRule } from './rules/NestedOrmLoopRule';
import { additionalOrmRules } from './rules/AdditionalOrmRules';

export function allPerformanceRules(): PerformanceRule[] {
  return [...makeOrmCallInLoopRules(), searchCountMisuseRule, repeatedEnvAccessRule, mappedInLoopRule, readInLoopRule, nestedOrmLoopRule, ...additionalOrmRules];
}

export function runOrmDoctor(
  analysis: PythonFileAnalysis,
  source: string,
  enabledRules: Record<string, boolean>
): OdooDiagnostic[] {
  const rules = allPerformanceRules();
  const diagnostics: OdooDiagnostic[] = [];
  // Every individual rule reads `ctx.analysis.modelContributions`; rather than editing each rule
  // to separately also iterate `controllerContributions`, wrap each controller's methods in a
  // minimal synthetic contribution here — an N+1 loop pattern inside an HTTP controller method
  // is just as real a performance bug as one inside a model method, and rules only ever look at
  // `.methods`, never at the fields/inheritance that a real model contribution would also carry.
  const augmentedAnalysis: PythonFileAnalysis = {
    ...analysis,
    modelContributions: [
      ...analysis.modelContributions,
      ...analysis.controllerContributions.map((c) => ({
        className: c.className,
        inherit: [],
        inherits: {},
        fields: [],
        methods: c.methods,
        module: c.module,
        location: c.location,
        baseClass: 'Model' as const,
        inheritLocations: [],
      })),
    ],
  };
  for (const rule of rules) {
    diagnostics.push(...rule.run({ analysis: augmentedAnalysis, source, enabledRules }));
  }
  return diagnostics;
}
