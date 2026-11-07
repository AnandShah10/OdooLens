import { OdooDiagnostic } from '../../semantic/OdooTypes';
import { PythonFileAnalysis } from '../../parser/python/OdooModelExtractor';

export interface SecurityRuleConfig {
  'sudo-bypass'?: boolean;
  'unrestricted-search'?: boolean;
  'public-controller-mutation'?: boolean;
  'csrf-disabled-route'?: boolean;
  'sudo-mutation-without-auth-check'?: boolean;
}

const ROUTE_DECORATOR_NAMES = new Set(['http.route', 'route']);

// Calls that count as "this method checks authorization". Deliberately generous: a false
// negative here means a missed finding, but a false positive means telling a developer who
// DID add a check that they didn't — and developer trust matters more than coverage.
const AUTH_CHECK_CALLS = new Set([
  'check_access',
  'check_access_rights',
  'check_access_rule',
  'has_access',
  'has_group',
  'user_has_groups',
  'is_admin',
  'is_system',
  '_check_access',
  'ensure_one_access',
]);

// Decorators marking a method as framework-invoked or explicitly non-RPC rather than an
// entry point a remote caller would target on purpose.
const NON_ENTRYPOINT_DECORATORS = new Set([
  'api.private', 'private',
  'api.depends', 'depends',
  'api.depends_context', 'depends_context',
  'api.constrains', 'constrains',
  'api.onchange', 'onchange',
  'api.autovacuum', 'autovacuum',
]);

type AnalyzableMethods = PythonFileAnalysis['modelContributions'][number]['methods'];

/**
 * Static, conservative security analysis. Findings are phrased as "potential" issues with an
 * explicit confidence level — this module never claims a finding is definitely exploitable,
 * per the security-analysis requirements: static analysis cannot see access-group configuration
 * or runtime context, so every sudo()/search() finding here is a prompt for manual review.
 *
 * RPC-exposure awareness: `@http.route(...)`'s keyword arguments (`auth`, `csrf`) are now
 * parsed (see `OdooDecorator.kwargs` in semantic/OdooTypes.ts) and used to grade confidence —
 * a mutation behind `auth='public'` is a materially different risk than one behind the
 * (Odoo-default) `auth='user'`, and OdooLens now distinguishes them instead of treating every
 * `@http.route` the same regardless of its actual auth level.
 */
export function runSecurityAnalyzer(analysis: PythonFileAnalysis, config: SecurityRuleConfig): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  // Real Odoo controllers are `class X(http.Controller)`, not `models.Model` subclasses — their
  // route-decorated methods live in `controllerContributions`, extracted separately (see
  // OdooModelExtractor.ts). Model classes with an (unusual, but technically legal) inline
  // @http.route are still covered via `modelContributions` below.
  for (const contribution of analysis.controllerContributions) {
    diagnostics.push(...analyzeMethodsForSecurity(contribution.methods, config));
  }
  for (const contribution of analysis.modelContributions) {
    diagnostics.push(...analyzeMethodsForSecurity(contribution.methods, config));
    diagnostics.push(...analyzeModelMethodsForMissingAuthCheck(contribution.methods, config));
  }

  return diagnostics;
}

/**
 * A public model method is callable over XML-RPC/JSON-RPC by ANY authenticated user (that is
 * how Odoo's `execute_kw` works — see `rpcReachability` in ImpactAnalyzer). If such a method
 * escalates with `sudo()` and then mutates records without ever checking the caller's rights or
 * groups, the sudo() is not just a code smell: it makes the mutation available to whoever can
 * call the method. Reported as a low-confidence review prompt, not a vulnerability claim — the
 * check may live in a caller, a decorator, or record rules this analysis can't see.
 */
function analyzeModelMethodsForMissingAuthCheck(methods: AnalyzableMethods, config: SecurityRuleConfig): OdooDiagnostic[] {
  if (config['sudo-mutation-without-auth-check'] === false) return [];
  const diagnostics: OdooDiagnostic[] = [];
  for (const method of methods) {
    if (method.name.startsWith('_')) continue;
    if (method.decorators.some((d) => NON_ENTRYPOINT_DECORATORS.has(d.name) || ROUTE_DECORATOR_NAMES.has(d.name))) continue;
    const sudoCall = method.ormCalls.find((c) => c.method === 'sudo');
    if (!sudoCall) continue;
    const mutation = method.ormCalls.find((c) => ['write', 'create', 'unlink'].includes(c.method));
    if (!mutation) continue;
    if (method.calleeNames.some((n) => AUTH_CHECK_CALLS.has(n))) continue;
    diagnostics.push({
      ruleId: 'sudo-mutation-without-auth-check',
      message: `${method.name}() is a public method (callable over RPC by any authenticated user) that uses sudo() and then calls ${mutation.method}(), but contains no access check (check_access, has_group, user_has_groups, ...). Confirm the caller is authorized to trigger this mutation — sudo() means record rules and ACLs will not stop them.`,
      severity: 'information',
      confidence: 'low',
      location: sudoCall.location,
      category: 'security',
      fixes: [],
    });
  }
  return diagnostics;
}

function analyzeMethodsForSecurity(methods: AnalyzableMethods, config: SecurityRuleConfig): OdooDiagnostic[] {
  const diagnostics: OdooDiagnostic[] = [];

  for (const method of methods) {
    const routeDecorator = method.decorators.find((d) => ROUTE_DECORATOR_NAMES.has(d.name));
    const isPublicApiSurface = Boolean(routeDecorator);
    const authLevel = routeDecorator?.kwargs['auth']; // undefined means Odoo's default ('user')
    const isPublicAuth = authLevel === 'public';
    // NOTE: kwarg literal values are stringified via `String(evalLiteral(...))`, so a Python
    // `False` (evaluated to the JS boolean `false`) becomes the lowercase string 'false' here —
    // not the Python-source casing 'False'. See OdooModelExtractor.ts `parseDecorator`.
    const csrfDisabled = routeDecorator?.kwargs['csrf'] === 'false';

    if (routeDecorator && csrfDisabled && config['csrf-disabled-route'] !== false) {
      diagnostics.push({
        ruleId: 'csrf-disabled-route',
        message:
          'This route explicitly disables CSRF protection (csrf=False). This is sometimes required for external webhooks/API integrations, but confirm it is genuinely needed here and that the route does not perform sensitive state changes based on unauthenticated cross-site requests.',
        severity: 'warning',
        confidence: 'medium',
        location: method.location,
        category: 'security',
        fixes: [],
      });
    }

    for (const call of method.ormCalls) {
      if (call.method === 'sudo' && config['sudo-bypass'] !== false) {
        diagnostics.push({
          ruleId: 'sudo-bypass',
          message: isPublicAuth
            ? "sudo() is called from a route with auth='public' — this combination (unauthenticated caller + elevated ORM privileges) is the classic shape of an access-control vulnerability. Verify every ORM call between here and the route's mutations is scoped as narrowly as possible."
            : 'sudo() bypasses normal record rules and access rights for every ORM call chained after it. Verify that the intended authorization scope is deliberate and as narrow as possible (prefer sudo() on a specific recordset, not the whole model, and avoid it on public-facing methods).',
          severity: 'warning',
          confidence: isPublicAuth ? 'high' : isPublicApiSurface ? 'medium' : 'low',
          location: call.location,
          category: 'security',
          fixes: [],
        });
      }

      if (call.method === 'search' && config['unrestricted-search'] !== false) {
        const emptyDomain = /search(?:_read)?\s*\(\s*\[\s*\]/.test(call.rawText);
        if (emptyDomain && isPublicApiSurface) {
          diagnostics.push({
            ruleId: 'unrestricted-search',
            message: `An unrestricted search([]) is called from a route (auth=${
              authLevel ?? "'user' (default)"
            }). Confirm this cannot be used to enumerate records the caller should not see.`,
            severity: 'warning',
            confidence: isPublicAuth ? 'medium' : 'low',
            location: call.location,
            category: 'security',
            fixes: [],
          });
        }
      }
    }

    if (isPublicApiSurface && config['public-controller-mutation'] !== false) {
      const mutatingCalls = method.ormCalls.filter((c) => ['write', 'create', 'unlink'].includes(c.method));
      for (const call of mutatingCalls) {
        diagnostics.push({
          ruleId: 'public-controller-mutation',
          message: isPublicAuth
            ? `A route with auth='public' calls ${call.method}(), which mutates data WITHOUT requiring the caller to be authenticated. Confirm this is intentional and that the mutation is properly scoped/validated (this is a high-value target for abuse if not).`
            : `A route calls ${call.method}(), which mutates data. Confirm the route's \`auth\` setting (currently ${
                authLevel ?? "'user' (default)"
              }) and any explicit permission checks are appropriate for this mutation.`,
          severity: isPublicAuth ? 'warning' : 'information',
          confidence: isPublicAuth ? 'high' : 'low',
          location: call.location,
          category: 'security',
          fixes: [],
        });
      }
    }
  }

  return diagnostics;
}
