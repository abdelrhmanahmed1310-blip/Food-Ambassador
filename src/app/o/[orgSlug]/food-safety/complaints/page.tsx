import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listComplaints } from "@/modules/foodsafety/quality";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName } from "@/server/inventory-view";

const TONE = { OPEN: "danger", INVESTIGATING: "warning", RESOLVED: "success" } as const;

export default async function ComplaintsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/complaints">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const open = sp.open === "1";
  const [t, locale, format, rows] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    listComplaints(ctx, { open }),
  ]);
  const base = `/o/${orgSlug}/food-safety/complaints`;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${active ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-surface-muted"}`;
  return (
    <>
      <PageHeader
        title={t("complaints.title")}
        description={t("complaints.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "foodsafety.record") ? (
            <LinkButton href={`${base}/new`}>{t("complaints.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link href={base} className={chip(!open)} aria-current={!open ? "page" : undefined}>
          {t("common.all")}
        </Link>
        <Link
          href={`${base}?open=1`}
          className={chip(open)}
          aria-current={open ? "page" : undefined}
        >
          {t("complaints.openOnly")}
        </Link>
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={t("complaints.empty")} />
      ) : (
        <Table label={t("complaints.title")}>
          <thead>
            <tr>
              <Th>{t("complaints.number")}</Th>
              <Th>{t("complaints.category")}</Th>
              <Th>{t("complaints.product")}</Th>
              <Th>{t("complaints.description")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link
                    href={`${base}/${c.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {c.number}
                  </Link>
                  <span className="text-muted block text-xs">
                    {c.branch.code} ·{" "}
                    {format.dateTime(c.receivedAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                  </span>
                </Td>
                <Td>{t(`complaints.categories.${c.category}`)}</Td>
                <Td>{c.product ? productName(c.product, locale) : "—"}</Td>
                <Td className="max-w-xs truncate">{c.description}</Td>
                <Td>
                  <Badge tone={TONE[c.status]}>{t(`complaints.statuses.${c.status}`)}</Badge>
                  {c.nonConformance ? (
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {c.nonConformance.number}
                    </span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
