import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Menu engineering (DECISIONS.md ADR-107), the Kasavana–Smith method. Pure.
 * Among the items analysed, an item is popular when its share of items sold
 * is at least 70 % of an equal share (1 ÷ number of items), and profitable
 * when its contribution margin per item is at least the sales-weighted
 * average. Stars are both, plowhorses popular only, puzzles profitable only,
 * dogs neither. Items without a known cost are not classified.
 */

export const POPULARITY_FACTOR = new Decimal("0.7");

export type MenuClass = "STAR" | "PLOWHORSE" | "PUZZLE" | "DOG";

export interface MenuItemFigures {
  id: string;
  sold: DecimalInput;
  revenue: DecimalInput;
  /** Total standard cost of what was sold; null when unknown. */
  cost: DecimalInput | null;
}

export interface Classified {
  id: string;
  sold: Decimal;
  revenue: Decimal;
  cost: Decimal | null;
  /** Revenue ÷ sold. */
  averagePrice: Decimal | null;
  unitCost: Decimal | null;
  /** Average price − unit cost. */
  unitMargin: Decimal | null;
  totalMargin: Decimal | null;
  /** Cost ÷ revenue. */
  foodCost: Decimal | null;
  /** Share of items sold among the classified items. */
  mixShare: Decimal | null;
  menuClass: MenuClass | null;
}

export function classifyMenu(items: readonly MenuItemFigures[]): {
  items: Classified[];
  popularityThreshold: Decimal | null;
  averageMargin: Decimal | null;
} {
  const base = items.map((i) => {
    const sold = new Decimal(i.sold);
    const revenue = new Decimal(i.revenue);
    const cost = i.cost === null ? null : new Decimal(i.cost);
    const averagePrice = sold.gt(0) ? revenue.div(sold) : null;
    const unitCost = cost !== null && sold.gt(0) ? cost.div(sold) : null;
    const unitMargin =
      averagePrice !== null && unitCost !== null ? averagePrice.minus(unitCost) : null;
    return {
      id: i.id,
      sold,
      revenue,
      cost,
      averagePrice,
      unitCost,
      unitMargin,
      totalMargin: cost !== null ? revenue.minus(cost) : null,
      foodCost: cost !== null && revenue.gt(0) ? cost.div(revenue) : null,
    };
  });
  const analysed = base.filter((b) => b.unitMargin !== null && b.sold.gt(0));
  const totalSold = analysed.reduce((a, b) => a.plus(b.sold), new Decimal(0));
  const popularityThreshold = analysed.length > 0 ? POPULARITY_FACTOR.div(analysed.length) : null;
  const averageMargin = totalSold.gt(0)
    ? analysed.reduce((a, b) => a.plus(b.totalMargin!), new Decimal(0)).div(totalSold)
    : null;
  return {
    popularityThreshold,
    averageMargin,
    items: base.map((b) => {
      const inSet = analysed.includes(b);
      const mixShare = inSet && totalSold.gt(0) ? b.sold.div(totalSold) : null;
      let menuClass: MenuClass | null = null;
      if (inSet && mixShare !== null && popularityThreshold !== null && averageMargin !== null) {
        const popular = mixShare.gte(popularityThreshold);
        const profitable = b.unitMargin!.gte(averageMargin);
        menuClass = popular ? (profitable ? "STAR" : "PLOWHORSE") : profitable ? "PUZZLE" : "DOG";
      }
      return { ...b, mixShare, menuClass };
    }),
  };
}
