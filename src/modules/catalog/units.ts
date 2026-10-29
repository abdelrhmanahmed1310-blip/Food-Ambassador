import { Decimal, roundQuantity, toDecimal, type DecimalInput } from "@/lib/decimal";
import { businessRuleViolation } from "@/server/errors";

export const DIMENSIONS = ["MASS", "VOLUME", "COUNT"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface UnitDef {
  id: string;
  code: string;
  dimension: Dimension;
  /**
   * Size in the dimension's base unit (g, ml, each). Null for packaging units
   * such as "case" or "bag", which only convert via a product-specific factor.
   */
  factorToBase: DecimalInput | null;
}

export interface ProductConversion {
  uomId: string;
  /** How many product base units one `uomId` holds (e.g. 1 case = 12 each). */
  factorToBase: DecimalInput;
}

/**
 * Multiplier that converts a quantity in `from` into the product's base unit.
 *
 * Rules (DATA_MODEL.md §3):
 * 1. Same unit → 1.
 * 2. A product-specific conversion for `from` wins (covers packaging units and
 *    cross-dimension cases such as "1 each ≈ 250 g" for that product only).
 * 3. Same dimension and both units have fixed sizes → ratio of sizes.
 * 4. Otherwise the units are incompatible: never guessed.
 */
export function conversionFactor(
  from: UnitDef,
  base: UnitDef,
  productConversions: readonly ProductConversion[],
): Decimal {
  if (from.id === base.id) return new Decimal(1);
  const specific = productConversions.find((c) => c.uomId === from.id);
  if (specific) {
    const f = toDecimal(specific.factorToBase);
    if (!f.isPositive() || f.isZero()) throw new RangeError("Conversion factor must be positive");
    return f;
  }
  if (
    from.dimension === base.dimension &&
    from.factorToBase !== null &&
    base.factorToBase !== null
  ) {
    return toDecimal(from.factorToBase).dividedBy(toDecimal(base.factorToBase));
  }
  throw businessRuleViolation(
    "INCOMPATIBLE_UNITS",
    `Cannot convert ${from.code} to ${base.code} for this product`,
    {
      from: from.code,
      to: base.code,
    },
  );
}

/** Convert to the product's base unit, rounded to the quantity scale (6 dp). */
export function toBaseQuantity(
  quantity: DecimalInput,
  from: UnitDef,
  base: UnitDef,
  productConversions: readonly ProductConversion[],
): Decimal {
  return roundQuantity(toDecimal(quantity).times(conversionFactor(from, base, productConversions)));
}

/** Units a quantity of this product may be entered in. */
export function compatibleUnits<T extends UnitDef>(
  units: readonly T[],
  base: UnitDef,
  productConversions: readonly ProductConversion[],
): T[] {
  return units.filter((u) => {
    try {
      conversionFactor(u, base, productConversions);
      return true;
    } catch {
      return false;
    }
  });
}
