import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listShortfalls } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { postShortfallsAction } from "../actions";

/** Stock sold that the system did not show on hand; posted once the stock is recorded. */
export default async function ShortfallsPage({ params }: PageProps<"/o/[orgSlug]/pos/shortfalls">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.adjust")) notFound();
  const [t, format, rows] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listShortfalls(ctx),
  ]);
  const byWarehouse = new Map<string, typeof rows>();
  for (const r of rows)
    byWarehouse.set(r.warehouseId, [...(byWarehouse.get(r.warehouseId) ?? []), r]);
  return (
    <>
      <PageHeader
        title={t("pos.shortfalls")}
        description={t("pos.shortfallsIntro")}
        actions={
          <LinkButton href={`/o/${orgSlug}/pos`} variant="secondary">
            {t("pos.title")}
          </LinkButton>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title={t("pos.noShortfalls")} />
      ) : (
        <div className="space-y-6">
          {[...byWarehouse.entries()].map(([warehouseId, list]) => (
            <Card key={warehouseId} title={`${list[0].warehouse.code} — ${list[0].warehouse.name}`}>
              <Table label={t("pos.shortfalls")}>
                <thead>
                  <tr>
                    <Th>{t("pos.product")}</Th>
                    <Th>{t("pos.quantity")}</Th>
                    <Th>{t("pos.number")}</Th>
                    <Th>{t("pos.time")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        <span className="ltr-value font-mono">{s.product.sku}</span>{" "}
                        {s.product.nameEn}
                      </Td>
                      <Td className="ltr-value tabular-nums">
                        {s.quantity.toFixed()} {s.product.baseUom.code}
                      </Td>
                      <Td>
                        <Link
                          href={`/o/${orgSlug}/pos/orders/${s.order.id}`}
                          className="text-primary ltr-value font-mono hover:underline"
                        >
                          {s.order.number}
                        </Link>
                      </Td>
                      <Td className="ltr-value">
                        {format.dateTime(s.order.orderedAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: ctx.timeZone,
                        })}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-4">
                <ConfirmActionButton
                  action={postShortfallsAction.bind(null, orgSlug, warehouseId)}
                  label={t("pos.postShortfalls")}
                  variant="primary"
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
