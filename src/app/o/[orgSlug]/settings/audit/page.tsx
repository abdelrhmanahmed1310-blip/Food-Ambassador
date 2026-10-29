import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { inputClass, buttonClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { listAuditEvents } from "@/modules/audit/service";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const ENTITY_TYPES = [
  "organization",
  "branch",
  "warehouse",
  "storage_location",
  "membership",
  "invitation",
  "role",
] as const;

function summarize(changes: unknown): string {
  if (!changes || typeof changes !== "object") return "";
  return Object.entries(changes as Record<string, unknown>)
    .map(([k, v]) => {
      if (v && typeof v === "object" && "to" in (v as object))
        return `${k}: ${JSON.stringify((v as { from: unknown }).from)} → ${JSON.stringify((v as { to: unknown }).to)}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("; ");
}

export default async function AuditPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/settings/audit">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "audit.view")) notFound();
  const entityType =
    typeof sp.entityType === "string" && (ENTITY_TYPES as readonly string[]).includes(sp.entityType)
      ? sp.entityType
      : undefined;
  const page = pageSchema.parse(sp.page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listAuditEvents(ctx, { page, entityType }),
  ]);

  return (
    <>
      <PageHeader title={t("audit.title")} />
      <form method="get" className="mb-4 flex gap-2">
        <label htmlFor="entityType" className="sr-only">
          {t("audit.entity")}
        </label>
        <select
          id="entityType"
          name="entityType"
          defaultValue={entityType ?? ""}
          className={`${inputClass} sm:w-64`}
        >
          <option value="">{t("audit.allTypes")}</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`audit.entityTypes.${type}`)}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary")}>
          {t("common.apply")}
        </button>
      </form>
      {result.events.length === 0 ? (
        <EmptyState title={t("audit.empty")} />
      ) : (
        <Table label={t("audit.title")}>
          <thead>
            <tr>
              <Th>{t("audit.when")}</Th>
              <Th>{t("audit.actor")}</Th>
              <Th>{t("audit.action")}</Th>
              <Th>{t("audit.entity")}</Th>
              <Th>{t("audit.changes")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.events.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">
                  {format.dateTime(e.occurredAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}
                </Td>
                <Td>{e.actorName ?? t("audit.system")}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{e.action}</span>
                </Td>
                <Td>
                  {t.has(`audit.entityTypes.${e.entityType}`)
                    ? t(`audit.entityTypes.${e.entityType}`)
                    : e.entityType}
                </Td>
                <Td className="max-w-md break-words">
                  <span className="ltr-value text-muted font-mono text-xs">
                    {summarize(e.changes)}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={`/o/${orgSlug}/settings/audit`}
        params={{ entityType }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
