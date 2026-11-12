/**
 * Product category tree helpers (DECISIONS.md ADR-134). Pure: used by the
 * services, the CSV import, the pages and put-away rules.
 */

export const MAX_CATEGORY_DEPTH = 3;

export interface CategoryNode {
  id: string;
  parentId: string | null;
}

/** The category and its ancestors, nearest first: [id, parent, grandparent…]. */
export function lineage(id: string, parents: ReadonlyMap<string, string | null>): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = id;
  while (cur && !out.includes(cur) && out.length <= 64) {
    out.push(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
}

/** All categories under `id` (not including it). */
export function descendants(id: string, nodes: readonly CategoryNode[]): string[] {
  const children = new Map<string, string[]>();
  for (const n of nodes)
    if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.includes(c) || c === id) continue;
    out.push(c);
    stack.push(...(children.get(c) ?? []));
  }
  return out;
}

/** Height of the subtree under `id` (a leaf is 1). */
function height(id: string, nodes: readonly CategoryNode[]): number {
  const kids = nodes.filter((n) => n.parentId === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => height(k.id, nodes))) : 0);
}

/**
 * Why `id` cannot be placed under `parentId`, or null when it can: its own
 * subcategory (a loop), or deeper than MAX_CATEGORY_DEPTH levels.
 */
export function placementProblem(
  id: string | null,
  parentId: string | null,
  nodes: readonly CategoryNode[],
): "CATEGORY_LOOP" | "CATEGORY_TOO_DEEP" | null {
  if (!parentId)
    return id ? (height(id, nodes) > MAX_CATEGORY_DEPTH ? "CATEGORY_TOO_DEEP" : null) : null;
  if (id && (parentId === id || descendants(id, nodes).includes(parentId))) return "CATEGORY_LOOP";
  const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
  const parentDepth = lineage(parentId, parents).length;
  const own = id ? height(id, nodes) : 1;
  return parentDepth + own > MAX_CATEGORY_DEPTH ? "CATEGORY_TOO_DEEP" : null;
}

/** Categories in tree order (parents before children, siblings by code), with depth and path. */
export function treeOrder<T extends CategoryNode & { code: string }>(
  nodes: readonly T[],
): Array<T & { depth: number; path: T[] }> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    // A parent outside the list (e.g. filtered out) puts the category at the top.
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), n]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.code.localeCompare(b.code));
  const out: Array<T & { depth: number; path: T[] }> = [];
  const walk = (parent: string | null, path: T[]) => {
    for (const n of byParent.get(parent) ?? []) {
      if (path.includes(n)) continue;
      out.push({ ...n, depth: path.length, path: [...path, n] });
      walk(n.id, [...path, n]);
    }
  };
  walk(null, []);
  return out;
}
