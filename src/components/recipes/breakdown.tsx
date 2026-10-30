import { getTranslations } from "next-intl/server";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import type { LineCost, VersionCost } from "@/modules/recipes/costing";

type Names = Record<string, { code: string; name: string; nameAr: string | null }>;
type Formatter = (v: { toString(): string }) => string;

/** Line-by-line cost of a version, with sub-recipes expanded beneath their line. */
export async function CostBreakdown({
  cost,
  names,
  locale,
  money,
  unitCost,
  fmt,
}: {
  cost: VersionCost;
  names: Names;
  locale: string;
  money: Formatter;
  unitCost: Formatter;
  fmt: Formatter;
}) {
  const t = await getTranslations();
  const label = (l: LineCost) => {
    const n = names[(l.productId ?? l.subRecipeId) as string];
    return n ? `${n.code} — ${(locale === "ar" && n.nameAr) || n.name}` : "—";
  };
  const rows = (c: VersionCost, depth: number): React.ReactNode[] =>
    c.lines.flatMap((l) => [
      <tr key={`${c.versionId}-${l.ingredientId}`} className={depth > 0 ? "bg-surface-muted" : ""}>
        <Td>
          <span style={{ paddingInlineStart: `${depth * 1.25}rem` }} className="block">
            {label(l)}
          </span>
        </Td>
        <Td className="tabular-nums">
          <span className="ltr-value whitespace-nowrap">
            {fmt(l.grossQuantity)} {l.uom}
          </span>
          {l.wasteFraction !== "0" ? (
            <span className="text-muted block text-xs">
              {t("recipes.netWithWaste", {
                net: `${fmt(l.quantity)} ${l.uom}`,
                waste: fmt(Number(l.wasteFraction) * 100),
              })}
            </span>
          ) : null}
        </Td>
        <Td className="tabular-nums">
          {l.unitCost ? (
            <span className="ltr-value whitespace-nowrap">
              {unitCost(l.unitCost)} / {l.costedUnit}
            </span>
          ) : (
            "—"
          )}
        </Td>
        <Td>
          {l.missing ? (
            <Badge tone="warning">{t(`recipes.missing.${l.missing}`)}</Badge>
          ) : (
            <>
              {t(`recipes.sources.${l.source as string}`)}
              {l.sourceRef && l.source === "LAST_PURCHASE" ? (
                <span className="ltr-value text-muted block font-mono text-xs">{l.sourceRef}</span>
              ) : null}
            </>
          )}
        </Td>
        <Td className="tabular-nums">
          <span className="ltr-value whitespace-nowrap">{l.cost ? money(l.cost) : "—"}</span>
        </Td>
      </tr>,
      ...(l.sub ? rows(l.sub, depth + 1) : []),
    ]);
  return (
    <Table label={t("recipes.breakdown")}>
      <thead>
        <tr>
          <Th>{t("recipes.ingredient")}</Th>
          <Th>{t("recipes.grossQuantity")}</Th>
          <Th>{t("recipes.unitCost")}</Th>
          <Th>{t("recipes.source")}</Th>
          <Th>{t("recipes.cost")}</Th>
        </tr>
      </thead>
      <tbody>{rows(cost, 0)}</tbody>
    </Table>
  );
}
