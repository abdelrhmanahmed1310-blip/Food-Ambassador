import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ListFilters } from "@/components/ui/list-filters";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listSuppliers } from "@/modules/procurement/suppliers";
import { pageSchema } from "@/modules/shared/schemas";
import { listStatusSchema } from "@/modules/sites/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const APPROVALS = ["PENDING_APPROVAL", "APPROVED", "BLOCKED"] as const;
const STATUS_TONE = {
  PENDING_APPROVAL: "warning",
  APPROVED: "success",
  BLOCKED: "danger",
} as const;

export default async function SuppliersPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/suppliers">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "suppliers.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = listStatusSchema.parse(sp.status);
  const page = pageSchema.parse(sp.page);
  const approval = APPROVALS.find((a) => a === sp.approval);
  const documents =
    sp.documents === "expired" || sp.documents === "expiring" ? sp.documents : undefined;
  const [t, locale, result] = await Promise.all([
    getTranslations(),
    getLocale(),
    listSuppliers(ctx, { q, status, page, approval, documents }),
  ]);
  const base = `/o/${orgSlug}/suppliers`;
  return (
    <>
      <PageHeader
        title={t("suppliers.title")}
        actions={
          hasPermission(ctx.grants, "suppliers.manage") ? (
            <LinkButton href={`${base}/new`}>{t("suppliers.new")}</LinkButton>
          ) : undefined
        }
      />
      <ListFilters q={q} status={status} />
      <nav
        aria-label={t("suppliers.compliance.filter")}
        className="mb-4 flex flex-wrap gap-2 text-sm"
      >
        {[
          { key: "all", href: base, active: !approval && !documents },
          ...APPROVALS.map((a) => ({
            key: `status.${a}`,
            href: `${base}?approval=${a}`,
            active: approval === a,
          })),
          ...(["expired", "expiring"] as const).map((d) => ({
            key: `documentsFilter.${d}`,
            href: `${base}?documents=${d}`,
            active: documents === d,
          })),
        ].map((f) => (
          <Link
            key={f.key}
            href={f.href}
            aria-current={f.active ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${
              f.active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-surface-muted"
            }`}
          >
            {t(`suppliers.compliance.${f.key}`)}
          </Link>
        ))}
      </nav>
      {result.total === 0 ? (
        q ? (
          <EmptyState title={t("common.noResults")} />
        ) : (
          <EmptyState title={t("suppliers.empty")} hint={t("suppliers.emptyHint")} />
        )
      ) : (
        <Table label={t("suppliers.title")}>
          <thead>
            <tr>
              <Th>{t("suppliers.code")}</Th>
              <Th>{t("suppliers.name")}</Th>
              <Th>{t("suppliers.compliance.statusLabel")}</Th>
              <Th>{t("suppliers.contactName")}</Th>
              <Th>{t("suppliers.leadTimeDays")}</Th>
              <Th>{t("suppliers.productsCount")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((s) => (
              <tr key={s.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{s.code}</span>
                </Td>
                <Td>
                  <Link
                    href={`${base}/${s.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {(locale === "ar" && s.nameAr) || s.name}
                  </Link>
                  {s.archivedAt ? (
                    <span className="ms-2">
                      <Badge tone="muted">{t("common.archived")}</Badge>
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[s.status]}>
                    {t(`suppliers.compliance.status.${s.status}`)}
                  </Badge>
                </Td>
                <Td>{s.contactName ?? "—"}</Td>
                <Td className="tabular-nums">{s.leadTimeDays ?? "—"}</Td>
                <Td className="tabular-nums">{s._count.products}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={{ q, status, approval, documents }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
