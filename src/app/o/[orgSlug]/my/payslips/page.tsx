import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { myPayslips } from "@/modules/payroll/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";

/** The signed-in employee's own payslips (ADR-123). */
export default async function MyPayslipsPage({ params }: PageProps<"/o/[orgSlug]/my/payslips">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const slips = await myPayslips(ctx).catch(() => null);
  if (!slips) notFound();
  const t = await getTranslations("payroll");
  const moneyOf = await moneyIn(slips.map((s) => s.run.currency));
  return (
    <>
      <PageHeader title={t("myPayslips")} />
      {slips.length === 0 ? (
        <EmptyState title={t("noPayslips")} />
      ) : (
        <Table label={t("myPayslips")}>
          <thead>
            <tr>
              <Th>{t("period")}</Th>
              <Th>{t("gross")}</Th>
              <Th>{t("net")}</Th>
              <Th>{t("status")}</Th>
              <Th>{t("payslip")}</Th>
            </tr>
          </thead>
          <tbody>
            {slips.map((s) => (
              <tr key={s.id}>
                <Td className="ltr-value">{s.run.period.toISOString().slice(0, 7)}</Td>
                <Td className="ltr-value tabular-nums">{moneyOf(s.run.currency).money(s.gross)}</Td>
                <Td className="ltr-value font-medium tabular-nums">
                  {moneyOf(s.run.currency).money(s.net)}
                </Td>
                <Td>{t(`statuses.${s.run.status}`)}</Td>
                <Td>
                  <a
                    href={`/o/${orgSlug}/hr/payroll/payslips/${s.id}/pdf?inline=1`}
                    className="text-primary hover:underline"
                  >
                    PDF
                  </a>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
