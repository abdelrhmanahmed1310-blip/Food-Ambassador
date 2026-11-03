import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { NewReturnForm } from "@/components/procurement/return-forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { receiptsToReturnFrom } from "@/modules/procurement/returns";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createReturnAction } from "../actions";

export default async function NewReturnPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/returns/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.receive")) notFound();
  const [t, format, receipts] = await Promise.all([
    getTranslations(),
    getFormatter(),
    receiptsToReturnFrom(ctx),
  ]);
  const receiptId = typeof sp.receiptId === "string" ? sp.receiptId : undefined;
  return (
    <>
      <PageHeader title={t("returns.newTitle")} description={t("returns.hint")} />
      {receipts.length === 0 ? (
        <EmptyState title={t("returns.noReceipts")} />
      ) : (
        <Card>
          <NewReturnForm
            action={createReturnAction.bind(null, orgSlug)}
            receiptId={receiptId}
            receipts={receipts.map((r) => ({
              value: r.id,
              label: `${r.number} — ${r.supplier.code} ${r.supplier.name} · ${r.warehouse.code} · ${format.dateTime(
                r.receivedAt,
                { dateStyle: "medium", timeZone: ctx.timeZone },
              )} · ${r.currency}`,
            }))}
          />
        </Card>
      )}
    </>
  );
}
