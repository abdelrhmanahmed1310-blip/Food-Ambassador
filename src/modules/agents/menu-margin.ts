import "server-only";
import { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { foodCostReport } from "@/modules/recipes/menu";
import { foodCostFraction } from "@/modules/recipes/pricing";
import type { TenantContext } from "@/modules/tenancy/context";
import type { NewProposal } from "./replenishment";
import { targetPrice, type Finding, type MenuMarginSettings } from "./rules";

/**
 * The menu & margin agent (DECISIONS.md ADR-142): it reads the food cost
 * report (ADR-032) — every active dish with its cost per portion at the
 * current cost, its price in effect and its target — and for each dish above
 * its target proposes the price that brings it back to the target, with the
 * food cost before and after. Approving adds that price from a later date
 * through the same service as the recipe page, with the approver's access.
 * Dishes whose cost is incomplete are reported and never priced, and dishes
 * without a price or target are reported, not guessed. Till prices on menu
 * items are separate and not changed.
 */

const pct = (fraction: Decimal) => fraction.times(100).toFixed(1);

export function canRunMenuMargin(ctx: TenantContext) {
  return hasPermission(ctx.grants, "recipes.costs.view");
}

export async function runMenuMargin(
  ctx: TenantContext,
  settings: MenuMarginSettings,
  count: () => void,
) {
  const report = await foodCostReport(ctx, {});
  count();
  const findings: Finding[] = [];
  const proposals: NewProposal[] = [];
  const incomplete = report.rows.filter((r) => r.status === "INCOMPLETE");
  const noPrice = report.rows.filter((r) => r.status === "NO_PRICE");
  const noTarget = report.rows.filter((r) => r.status === "NO_TARGET");
  for (const r of report.rows.filter((x) => x.status === "ABOVE_TARGET")) {
    const price = r.price!;
    const target = r.target!;
    if (!r.suggested || !price.net || !r.fraction) continue;
    const newPrice = targetPrice({
      suggestedNet: r.suggested,
      entered: price.entered,
      net: price.net,
      includesTax: price.includesTax,
    });
    // What the new price leaves after VAT, at the dish's own entered-to-net ratio.
    const newNet = price.includesTax
      ? newPrice.times(price.net).dividedBy(price.entered)
      : newPrice;
    const params = {
      dish: r.recipe.code,
      percent: pct(r.fraction),
      target: pct(target),
      price: price.entered.toFixed(2),
      newPrice: newPrice.toFixed(2),
    };
    findings.push({
      severity: "WARNING",
      code: "ABOVE_TARGET",
      params,
      link: `recipes/${r.recipe.id}`,
    });
    proposals.push({
      kind: "PRICE_CHANGE",
      title: `${r.recipe.code} · ${r.recipe.name}`,
      detail: {
        dish: r.recipe.code,
        name: r.recipe.name,
        costPerPortion: r.costPerPortion.toFixed(2),
        price: price.entered.toFixed(2),
        newPrice: newPrice.toFixed(2),
        includesTax: price.includesTax,
        foodCostPercent: pct(r.fraction),
        newFoodCostPercent: pct(foodCostFraction(r.costPerPortion, newNet)),
        targetPercent: pct(target),
        effectiveInDays: settings.effectiveInDays,
        currency: ctx.baseCurrency,
      },
      entityType: "recipe",
      entityId: r.recipe.id,
    });
  }
  if (incomplete.length)
    findings.push({
      severity: "WARNING",
      code: "COST_INCOMPLETE",
      params: { count: incomplete.length, dishes: codes(incomplete) },
      link: "recipes/food-cost",
    });
  if (noPrice.length)
    findings.push({
      severity: "INFO",
      code: "NO_DISH_PRICE",
      params: { count: noPrice.length, dishes: codes(noPrice) },
      link: "recipes/food-cost",
    });
  if (noTarget.length)
    findings.push({
      severity: "INFO",
      code: "NO_TARGET",
      params: { count: noTarget.length },
      link: "recipes/food-cost",
    });
  return {
    summary: {
      dishes: report.rows.length,
      aboveTarget: proposals.length,
      incomplete: incomplete.length,
    },
    findings,
    proposals,
  };
}

/** At most ten dish codes, then how many more. */
function codes(rows: ReadonlyArray<{ recipe: { code: string } }>) {
  const shown = rows.slice(0, 10).map((r) => r.recipe.code);
  return rows.length > 10 ? `${shown.join(", ")} +${rows.length - 10}` : shown.join(", ");
}
