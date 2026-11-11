export interface SelectionAnchor {
  id: string;
}
export function photoSelection(
  ordered: string[],
  selected: ReadonlySet<string>,
  anchor: SelectionAnchor | null,
  target: string,
  shift: boolean,
  limit = 1000,
) {
  const end = ordered.indexOf(target);
  if (end < 0) return { selected: new Set(selected), anchor, overflow: false };
  const start = shift && anchor ? ordered.indexOf(anchor.id) : -1;
  const next = new Set(selected),
    remove = selected.has(target);
  const range =
    start < 0 ? [target] : ordered.slice(Math.min(start, end), Math.max(start, end) + 1);
  for (const id of range) {
    if (remove) next.delete(id);
    else next.add(id);
  }
  if (next.size > limit) return { selected: new Set(selected), anchor, overflow: true };
  return { selected: next, anchor: start < 0 ? { id: target } : anchor, overflow: false };
}
