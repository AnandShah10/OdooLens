import { SourceLocation, XmlNodeRef } from '../../semantic/OdooTypes';

/** Elements that declare an external id via their `id` attribute. */
const ID_DECLARING_TAGS = new Set(['record', 'menuitem', 'template', 'act_window', 'report']);

export interface DeclaredXmlId {
  /** Always module-qualified: `module.local_id`. */
  xmlId: string;
  tag: string;
  module: string;
  file: string;
  location: SourceLocation;
}

export type XmlRefKind = 'field-ref' | 'eval-ref' | 'menuitem-action' | 'menuitem-parent' | 'menuitem-groups' | 'button-action';

export interface XmlRefUse {
  /** The reference exactly as written in source. */
  written: string;
  /** Module-qualified form: a bare `foo` in module `m` means `m.foo`. */
  qualified: string;
  kind: XmlRefKind;
  location: SourceLocation;
}

function qualify(id: string, module: string): string {
  return id.includes('.') ? id : `${module}.${id}`;
}

function* walk(node: XmlNodeRef): Generator<XmlNodeRef> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

export function extractDeclaredIds(root: XmlNodeRef, module: string, file: string): DeclaredXmlId[] {
  const out: DeclaredXmlId[] = [];
  for (const node of walk(root)) {
    const id = node.attributes.id;
    if (id && ID_DECLARING_TAGS.has(node.tag)) {
      out.push({ xmlId: qualify(id, module), tag: node.tag, module, file, location: node.location });
    }
  }
  return out;
}

/**
 * Every place the XML references another record by external id. Deliberately excludes
 * `<field name="inherit_id" ref="...">` — view-inheritance targets already have their own,
 * more specific check (`xml-missing-inherit-target`), and reporting them here too would
 * double-report the same problem.
 */
export function extractRefUses(root: XmlNodeRef, module: string): XmlRefUse[] {
  const out: XmlRefUse[] = [];
  const push = (written: string, kind: XmlRefKind, node: XmlNodeRef) => {
    const w = written.trim();
    if (w) out.push({ written: w, qualified: qualify(w, module), kind, location: node.location });
  };

  for (const node of walk(root)) {
    if (node.tag === 'field') {
      if (node.attributes.ref && node.attributes.name !== 'inherit_id') push(node.attributes.ref, 'field-ref', node);
      const evalAttr = node.attributes.eval;
      if (evalAttr) {
        for (const m of evalAttr.matchAll(/\bref\(\s*['"]([\w.]+)['"]\s*\)/g)) push(m[1], 'eval-ref', node);
      }
    } else if (node.tag === 'menuitem') {
      if (node.attributes.action) push(node.attributes.action, 'menuitem-action', node);
      if (node.attributes.parent) push(node.attributes.parent, 'menuitem-parent', node);
      if (node.attributes.groups) {
        for (const g of node.attributes.groups.split(',')) {
          // A leading `-` means "remove this group" — still a reference to that group's id.
          push(g.trim().replace(/^-/, ''), 'menuitem-groups', node);
        }
      }
    } else if (node.tag === 'button' && node.attributes.type === 'action') {
      const name = node.attributes.name;
      // A bare number is a raw database id (legal but unresolvable statically); only dotted
      // external ids are checkable.
      if (name && name.includes('.') && !/^\d+$/.test(name)) push(name, 'button-action', node);
    }
  }
  return out;
}
