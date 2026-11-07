import { XmlNodeRef, OdooViewRecord } from '../../semantic/OdooTypes';

export interface ViewMergeIssue {
  view: OdooViewRecord;
  message: string;
  targetExpr: string;
}

export interface MergeResult {
  effectiveArch: XmlNodeRef | null;
  issues: ViewMergeIssue[];
  /** Node -> the view record whose inherit patch introduced it, for "show modifications" UX. */
  provenance: Map<XmlNodeRef, OdooViewRecord>;
}

function cloneNode(node: XmlNodeRef, parent?: XmlNodeRef): XmlNodeRef {
  const clone: XmlNodeRef = {
    tag: node.tag,
    attributes: { ...node.attributes },
    children: [],
    location: node.location,
    text: node.text,
    parent,
  };
  clone.children = node.children.map((c) => cloneNode(c, clone));
  return clone;
}

/**
 * Resolves a very common, practically important subset of Odoo's XPath dialect used in
 * view-inheritance patches: `//tag[@attr='value']` and bare `tag[@attr='value']`, matched
 * anywhere in the tree. This is a deliberate static approximation (see ARCHITECTURE.md) —
 * it does not implement general XPath axes, predicates, or functions.
 */
function findByApproxXpath(root: XmlNodeRef, expr: string): XmlNodeRef | null {
  const m = expr.trim().match(/^\/\/?([a-zA-Z0-9_]+)(?:\[@([a-zA-Z0-9_:.-]+)=['"]([^'"]*)['"]\])?$/);
  if (!m) return null;
  const [, tag, attr, val] = m;
  let found: XmlNodeRef | null = null;
  const visit = (n: XmlNodeRef) => {
    if (found) return;
    if (n.tag === tag && (!attr || n.attributes[attr] === val)) {
      found = n;
      return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return found;
}

/** Locates the node a shorthand `<field name="x" position="after">` (no <xpath>) targets. */
function findShorthandTarget(root: XmlNodeRef, patchNode: XmlNodeRef): XmlNodeRef | null {
  const nameAttr = patchNode.attributes.name;
  if (!nameAttr) return null;
  let found: XmlNodeRef | null = null;
  const visit = (n: XmlNodeRef) => {
    if (found) return;
    if (n.tag === patchNode.tag && n.attributes.name === nameAttr) {
      found = n;
      return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return found;
}

function applyPosition(target: XmlNodeRef, patch: XmlNodeRef, position: string): void {
  const parent = target.parent;
  switch (position) {
    case 'replace':
      if (parent) {
        const idx = parent.children.indexOf(target);
        if (idx >= 0) {
          const replacement = patch.children.length > 0 ? patch.children : [patch];
          for (const r of replacement) r.parent = parent;
          parent.children.splice(idx, 1, ...replacement);
        }
      }
      break;
    case 'before':
      if (parent) {
        const idx = parent.children.indexOf(target);
        if (idx >= 0) {
          patch.children.forEach((c) => (c.parent = parent));
          parent.children.splice(idx, 0, ...patch.children);
        }
      }
      break;
    case 'inside':
      patch.children.forEach((c) => (c.parent = target));
      target.children.push(...patch.children);
      break;
    case 'attributes': {
      for (const attrNode of patch.children) {
        if (attrNode.tag === 'attribute' && attrNode.attributes.name) {
          target.attributes[attrNode.attributes.name] = attrNode.text ?? '';
        }
      }
      break;
    }
    case 'after':
    default:
      if (parent) {
        const idx = parent.children.indexOf(target);
        if (idx >= 0) {
          patch.children.forEach((c) => (c.parent = parent));
          parent.children.splice(idx + 1, 0, ...patch.children);
        }
      }
      break;
  }
}

/**
 * Applies an ordered chain of inheriting views onto a base view's arch, producing a best-effort
 * "effective" view tree plus any patches that failed to resolve against it (candidate XML errors).
 *
 * `chain` must already be topologically ordered (base first, then each inheriting view in the
 * order OdooLens discovered them). True Odoo load order also depends on the `priority` field and
 * the module dependency graph; OdooLens orders by (module dependency order, then priority, then
 * discovery order) as its best static approximation.
 */
export function mergeViewChain(base: OdooViewRecord, chain: OdooViewRecord[]): MergeResult {
  const issues: ViewMergeIssue[] = [];
  const provenance = new Map<XmlNodeRef, OdooViewRecord>();
  if (!base.archNode) return { effectiveArch: null, issues, provenance };

  let effective = cloneNode(base.archNode);

  for (const view of chain) {
    if (!view.archNode) continue;
    const patchNodes = view.archNode.tag === 'xpath' ? [view.archNode] : view.archNode.children;
    // A top-level <data> wrapper is also valid.
    const actualPatches = view.archNode.tag === 'data' ? view.archNode.children : patchNodes;

    for (const patch of actualPatches) {
      if (patch.tag === 'xpath') {
        const expr = patch.attributes.expr ?? '';
        const position = patch.attributes.position ?? 'inside';
        const target = findByApproxXpath(effective, expr);
        if (!target) {
          issues.push({
            view,
            targetExpr: expr,
            message: `XPath target "${expr}" was not found in the inherited view "${base.xmlId}".`,
          });
          continue;
        }
        applyPosition(target, cloneNode(patch), position);
        for (const c of patch.children) provenance.set(c, view);
      } else if (patch.attributes.position) {
        // Shorthand: <field name="x" position="after">...</field>
        const target = findShorthandTarget(effective, patch);
        if (!target) {
          issues.push({
            view,
            targetExpr: `${patch.tag}[@name='${patch.attributes.name}']`,
            message: `Inheritance target "${patch.tag}[@name='${patch.attributes.name}']" was not found in the inherited view "${base.xmlId}".`,
          });
          continue;
        }
        applyPosition(target, cloneNode(patch), patch.attributes.position);
        provenance.set(patch, view);
      }
      // Nodes without `position` and not `<xpath>` are typically comments/metadata; ignored.
    }
  }

  return { effectiveArch: effective, issues, provenance };
}
