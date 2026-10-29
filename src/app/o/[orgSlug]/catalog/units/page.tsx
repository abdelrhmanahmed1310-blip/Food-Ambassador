import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { UnitForm } from "@/components/inventory/forms";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listUnits } from "@/modules/catalog/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { quantityFormatter } from "@/server/inventory-view";
import { createUnitAction } from "../actions";

const BASE_UNIT = { MASS: "g", VOLUME: "ml", COUNT: "each" } as const;

export default async function UnitsPage({ params }: PageProps<"/o/[orgSlug]/catalog/units">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "catalog.view")) notFound();
  const [t, locale, units, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    listUnits(ctx),
    quantityFormatter(),
  ]);
  return (
    <>
      <PageHeader title={t("catalog.unitsTitle")} description={t("catalog.unitsHint")} />
      <div className="space-y-6">
        <Table label={t("catalog.unitsTitle")}>
          <thead>
            <tr>
              <Th>{t("catalog.code")}</Th>
              <Th>{t("branches.name")}</Th>
              <Th>{t("catalog.dimension")}</Th>
              <Th>{t("catalog.size")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{u.code}</span>
                </Td>
                <Td>{locale === "ar" ? u.nameAr : u.nameEn}</Td>
                <Td>{t(`catalog.dimensions.${u.dimension}`)}</Td>
                <Td>
                  {u.factorToBase === null ? (
                    <span className="text-muted">{t("catalog.packaging")}</span>
                  ) : (
                    <span className="ltr-value tabular-nums">
                      {fmt(u.factorToBase)} {BASE_UNIT[u.dimension]}
                    </span>
                  )}
                </Td>
                <Td>
                  {u.organizationId ? (
                    <Badge>{t("catalog.custom")}</Badge>
                  ) : (
                    <Badge tone="muted">{t("catalog.system")}</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {hasPermission(ctx.grants, "catalog.manage") ? (
          <Card title={t("catalog.newUnit")}>
            <UnitForm action={createUnitAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
