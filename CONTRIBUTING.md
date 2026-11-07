# Contributing

## Ground rules

1. **Reuse the semantic index.** If a new feature needs to know about a model, field, method,
   module, or view, it reads from `OdooWorkspaceIndex`. Do not write a second parser or a
   second inheritance-resolution algorithm.
2. **Framework-independent code stays framework-independent.** Nothing under `parser/`,
   `semantic/`, `index/`, `analyzer/`, or `versioning/` may `import` from `vscode`. This is what
   keeps that layer unit-testable without an Extension Development Host.
3. **Every diagnostic needs a confidence level and (where relevant) a help link.** Prefer
   under-claiming over over-claiming — a false "definitely wrong" erodes trust faster than a
   missed true positive.
4. **New migration rules go in `src/versioning/MigrationRules.ts` as data**, with a real
   documentation URL, not as logic inside `MigrationAnalyzer.ts`. Don't invent a rule you
   haven't verified against Odoo's actual changelog/release notes.
5. **New ORM Doctor / Security rules implement the `PerformanceRule` interface** (or, for
   security, follow the existing flat-function pattern in `SecurityAnalyzer.ts`) so they're
   independently testable and independently toggleable via configuration.

## Adding an ORM Doctor rule

1. Create `src/analyzer/performance/rules/YourRule.ts` implementing `PerformanceRule`.
2. Register it in `src/analyzer/performance/OrmDoctor.ts` → `allPerformanceRules()`.
3. Add a default entry to `odooIntelligence.ormDoctor.rules` in `package.json`.
4. Add a fixture (or extend an existing one under `tests/fixtures/basic_odoo/`) that triggers
   it, plus a test in `tests/analyzer/`.

## Adding a migration rule

1. Add an entry to `MIGRATION_RULES` in `src/versioning/MigrationRules.ts` with a real
   `documentationUrl` pointing at Odoo's official upgrade/deprecation docs.
2. Add a regression test to `tests/analyzer/LogAndMigration.test.ts` (or a new file) asserting
   both the positive case (rule fires) and a negative case (rule does not fire on unrelated
   code).

## Adding a language feature

`ModelContextResolver.resolveModelContext()` is the single place that decides "what model does
this expression refer to". If you need to recognize a new pattern (e.g. resolving through a
second variable hop, or recognizing `self.mapped('field_id').method()` chains), extend it there
— do not duplicate context-resolution logic inside `completion.ts`/`hover.ts`/`definition.ts`.
Any new pattern must come with an honest confidence level.

## Running tests

```bash
npm run compile   # tsc type-check + emit
npm run lint      # eslint (flat config, eslint.config.js) — should report zero warnings
npm test          # mocha + ts-node against tests/**/*.test.ts
npm run test:integration   # real Extension Development Host suite (needs internet access on first run)
```

Tests run against the parser/index/analyzer layer directly and do not require VS Code. If you
add a feature under `language/`, `commands/`, or `webview/` that needs the real `vscode`
module, add an integration test to `src/test/suite/extension.integration.test.ts` (see
ARCHITECTURE.md "Testing strategy" — and if the feature has pure logic in it, follow the
`GraphBuilder.ts`/`DependencyGraphPanel.ts` split so that logic stays unit-testable).

## Code style

- TypeScript strict mode is on (`tsconfig.json`). Please don't disable it locally.
- Prefer small, pure functions in `analyzer/`/`index/`/`parser/` — they're much easier to unit
  test than anything that reaches into `vscode.window`.
- Every publicly-exported function/class in a new file should have a docstring explaining *why*
  it exists and, if it's a static approximation of something dynamic, *what it does not cover*.
