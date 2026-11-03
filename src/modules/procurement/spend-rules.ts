/**
 * Spend and purchase price variance (DECISIONS.md ADR-095). Pure; no I/O.
 * Every amount here is already in the report currency.
 */
import { Decimal } from "@/lib/decimal";

/** One accepted receipt line, valued (accepted quantity × charged price × the receipt's rate). */
export interface ReceivedRow {
  supplierId: string;
  productId: string;
  categoryId: string | null;
  branchId: string;
  /** YYYY-MM of the receipt day. */
  month: string;
  value: Decimal;
  /** (charged − ordered price) × accepted quantity × rate; positive = paid more than ordered. */
  variance: Decimal;
  /** Accepted quantity in the product's base unit. */
  quantityBase: Decimal;
}

/** One posted return line, valued at the receipt's charged price and rate. */
export interface ReturnedRow {
  supplierId: string;
  productId: string;
  categoryId: string | null;
  branchId: string;
  month: string;
  value: Decimal;
}

export interface SpendGroup {
  key: string | null;
  received: Decimal;
  returned: Decimal;
  net: Decimal;
  /** Of the total net spend; null when the total is zero. */
  share: Decimal | null;
  lines: number;
  variance: Decimal;
  /** Distinct suppliers in the group. */
  suppliers: number;
}

/** Spend grouped by `keyOf`, largest net first. */
export function groupSpend(
  received: readonly ReceivedRow[],
  returned: readonly ReturnedRow[],
  keyOf: (r: ReceivedRow | ReturnedRow) => string | null,
): SpendGroup[] {
  const map = new Map<string | null, SpendGroup & { supplierSet: Set<string> }>();
  const at = (key: string | null) => {
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        received: new Decimal(0),
        returned: new Decimal(0),
        net: new Decimal(0),
        share: null,
        lines: 0,
        variance: new Decimal(0),
        suppliers: 0,
        supplierSet: new Set(),
      };
      map.set(key, g);
    }
    return g;
  };
  for (const r of received) {
    const g = at(keyOf(r));
    g.received = g.received.plus(r.value);
    g.variance = g.variance.plus(r.variance);
    g.lines += 1;
    g.supplierSet.add(r.supplierId);
  }
  for (const r of returned) {
    const g = at(keyOf(r));
    g.returned = g.returned.plus(r.value);
    g.supplierSet.add(r.supplierId);
  }
  const groups = [...map.values()];
  for (const g of groups) g.net = g.received.minus(g.returned);
  const total = groups.reduce((a, g) => a.plus(g.net), new Decimal(0));
  return groups
    .map(({ supplierSet, ...g }) => ({
      ...g,
      suppliers: supplierSet.size,
      share: total.isZero() ? null : g.net.dividedBy(total),
    }))
    .sort((a, b) => b.net.comparedTo(a.net) || String(a.key).localeCompare(String(b.key)));
}

/** Share of net spend with the largest `n` groups (supplier concentration). */
export function topShare(groups: readonly SpendGroup[], n: number): Decimal | null {
  const total = groups.reduce((a, g) => a.plus(g.net), new Decimal(0));
  if (total.isZero()) return null;
  return groups
    .slice(0, n)
    .reduce((a, g) => a.plus(g.net), new Decimal(0))
    .dividedBy(total);
}

export interface PriceChange {
  productId: string;
  /** Average price per base unit before and now. */
  before: Decimal;
  now: Decimal;
  /** (now − before) ÷ before. */
  change: Decimal | null;
  /** What the change cost on the quantity bought now: (now − before) × quantity now. */
  impact: Decimal;
  quantityNow: Decimal;
}

/**
 * Average price per base unit this period against the previous one, for
 * products bought in both; largest cost impact first.
 */
export function priceChanges(
  now: readonly ReceivedRow[],
  before: readonly ReceivedRow[],
): PriceChange[] {
  const sum = (rows: readonly ReceivedRow[]) => {
    const m = new Map<string, { value: Decimal; qty: Decimal }>();
    for (const r of rows) {
      if (r.quantityBase.isZero()) continue;
      const s = m.get(r.productId) ?? { value: new Decimal(0), qty: new Decimal(0) };
      s.value = s.value.plus(r.value);
      s.qty = s.qty.plus(r.quantityBase);
      m.set(r.productId, s);
    }
    return m;
  };
  const a = sum(before);
  const b = sum(now);
  const out: PriceChange[] = [];
  for (const [productId, n] of b) {
    const p = a.get(productId);
    if (!p) continue;
    const avgNow = n.value.dividedBy(n.qty);
    const avgBefore = p.value.dividedBy(p.qty);
    out.push({
      productId,
      before: avgBefore,
      now: avgNow,
      change: avgBefore.isZero() ? null : avgNow.minus(avgBefore).dividedBy(avgBefore),
      impact: avgNow.minus(avgBefore).times(n.qty),
      quantityNow: n.qty,
    });
  }
  return out.sort((x, y) => y.impact.abs().comparedTo(x.impact.abs()));
}

/** The period of the same length just before [from, to] (calendar days). */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const day = 86_400_000;
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  const length = Math.round((t - f) / day) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(f - length * day), to: iso(f - day) };
}
