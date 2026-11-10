/**
 * Menu board rules (ADR-133), pure so they are unit-tested and usable on
 * the screen. Times are HH:MM in the branch's time zone; a window may run
 * past midnight (e.g. 22:00–02:00).
 */
export function inWindow(now: string, from: string | null, to: string | null): boolean {
  if (!from || !to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** HH:MM now in a time zone. */
export function clockIn(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** Split items into pages of at most `size`, keeping each category's items together where they fit. */
export function paginate<T extends { category: { id: string } }>(
  items: readonly T[],
  size: number,
): T[][] {
  if (size <= 0 || items.length <= size) return [items.slice()];
  const pages: T[][] = [];
  let page: T[] = [];
  const groups = new Map<string, T[]>();
  for (const i of items) groups.set(i.category.id, [...(groups.get(i.category.id) ?? []), i]);
  for (const group of groups.values()) {
    if (page.length > 0 && page.length + group.length > size) {
      pages.push(page);
      page = [];
    }
    for (const i of group) {
      if (page.length === size) {
        pages.push(page);
        page = [];
      }
      page.push(i);
    }
  }
  if (page.length) pages.push(page);
  return pages;
}
