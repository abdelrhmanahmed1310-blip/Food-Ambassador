import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { InvoiceForm } from "@/components/invoices/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { invoiceFormOptions } from "@/modules/invoices/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createInvoiceAction } from "../actions";

export default async function NewInvoicePage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/invoices/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "invoices.manage")) notFound();
  const [t, locale, options] = await Promise.all([
    getTranslations(),
    getLocale(),
    invoiceFormOptions(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("invoices.new")} description={t("invoices.newHint")} />
      <Card>
        <InvoiceForm
          action={createInvoiceAction.bind(null, orgSlug)}
          currency={ctx.baseCurrency}
          submitLabel={t("invoices.create")}
          suppliers={options.suppliers.map((s) => ({
            value: s.id,
            label: `${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
          }))}
        />
      </Card>
    </>
  );
}
