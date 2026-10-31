import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CustomerForm } from "@/components/b2b/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCustomers } from "@/modules/b2b/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createCustomerAction } from "../actions";

export default async function CustomersPage({ params }: PageProps<"/o/[orgSlug]/b2b/customers">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.view")) notFound();
  const [t, locale, customers] = await Promise.all([
    getTranslations(),
    getLocale(),
    listCustomers(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("b2b.customers")} description={t("b2b.customersHint")} />
      <div className="space-y-6">
        {customers.length === 0 ? (
          <EmptyState title={t("b2b.noCustomers")} />
        ) : (
          <Table label={t("b2b.customers")}>
            <thead>
              <tr>
                <Th>{t("b2b.code")}</Th>
                <Th>{t("b2b.name")}</Th>
                <Th>{t("b2b.vatNumber")}</Th>
                <Th>{t("b2b.paymentTerms")}</Th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/b2b/customers/${c.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {c.code}
                    </Link>
                  </Td>
                  <Td>
                    <bdi>{(locale === "ar" && c.nameAr) || c.name}</bdi>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.taxId ?? "—"}</span>
                  </Td>
                  <Td className="tabular-nums">{c.paymentTermsDays ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {hasPermission(ctx.grants, "b2b.manage") ? (
          <Card title={t("b2b.addCustomer")}>
            <CustomerForm action={createCustomerAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
