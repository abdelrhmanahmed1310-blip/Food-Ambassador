import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { Pagination } from "@/components/ui/pagination";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { ISSUE_KINDS, listIssues } from "@/modules/nutrition/engine/quality";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { resolveIssueAction, scanQualityAction } from "../actions";
import { Tabs } from "../tabs";

/** Data quality findings: investigated and resolved or ignored with a note (ADR-132). */
export default async function QualityPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/quality">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const filters = {
    status: typeof sp.status === "string" ? sp.status : undefined,
    kind: typeof sp.kind === "string" ? sp.kind : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  };
  const [t, locale, format, r] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    getFormatter(),
    listIssues(ctx, filters),
  ]);
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  return (
    <>
      <PageHeader
        title={t("qualityTitle")}
        description={t("qualityIntro")}
        actions={
          manage ? (
            <ActionForm
              action={scanQualityAction.bind(null, orgSlug)}
              submitLabel={t("scan")}
              submitVariant="secondary"
              className="inline-flex flex-col items-start gap-1"
            >
              {null}
            </ActionForm>
          ) : null
        }
      />
      <Tabs orgSlug={orgSlug} current="quality" />
      <div className="space-y-6">
        <ul className="flex flex-wrap gap-2 text-sm">
          {ISSUE_KINDS.filter((k) => r.openByKind[k]).map((k) => (
            <li key={k}>
              <Link
                href={`?kind=${k}`}
                className="border-border hover:bg-surface-muted rounded-full border px-3 py-1"
              >
                {t(`issueKinds.${k}`)} <span className="ltr-value">({r.openByKind[k]})</span>
              </Link>
            </li>
          ))}
        </ul>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("status")}</span>
            <select
              name="status"
              defaultValue={r.status}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              {(["OPEN", "RESOLVED", "IGNORED"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`issueStatuses.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("kind")}</span>
            <select
              name="kind"
              defaultValue={r.kind ?? ""}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              <option value="">{t("all")}</option>
              {ISSUE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`issueKinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("search")}
          </button>
        </form>
        {r.items.length === 0 ? (
          <EmptyState title={t("noIssues")} />
        ) : (
          <Table label={t("qualityTitle")}>
            <thead>
              <tr>
                <Th>{t("food")}</Th>
                <Th>{t("kind")}</Th>
                <Th>{t("detail")}</Th>
                <Th>{t("raised")}</Th>
                <Th>{r.status === "OPEN" ? "" : t("resolution")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i) => (
                <tr key={i.id} data-testid="issue-row">
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/nutrition/foods/${i.food.id}`}
                      className="text-primary hover:underline"
                    >
                      <bdi>{(locale === "ar" && i.food.nameAr) || i.food.name}</bdi>
                    </Link>
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {i.food.sourceId}
                    </span>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        i.kind === "CHANGED_AFTER_VERIFICATION" || i.kind === "IMPLAUSIBLE_VALUE"
                          ? "danger"
                          : "warning"
                      }
                    >
                      {t(`issueKinds.${i.kind as "STALE"}`)}
                    </Badge>
                  </Td>
                  <Td className="text-xs">
                    <bdi>{i.detail}</bdi>
                  </Td>
                  <Td className="ltr-value text-xs">
                    {format.dateTime(i.createdAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                  </Td>
                  <Td className="min-w-64">
                    {i.status === "OPEN" ? (
                      manage ? (
                        <ActionForm
                          action={resolveIssueAction.bind(null, orgSlug, i.id)}
                          submitLabel={t("close")}
                          className="space-y-2"
                        >
                          <SelectField
                            name="status"
                            label={t("outcome")}
                            defaultValue="RESOLVED"
                            options={[
                              { value: "RESOLVED", label: t("issueStatuses.RESOLVED") },
                              { value: "IGNORED", label: t("issueStatuses.IGNORED") },
                            ]}
                          />
                          <TextField name="note" label={t("note")} required />
                        </ActionForm>
                      ) : null
                    ) : (
                      <span className="text-xs">
                        {t(`issueStatuses.${i.status as "RESOLVED"}`)} ·{" "}
                        <bdi>{i.resolutionNote}</bdi>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          basePath={`/o/${orgSlug}/nutrition/quality`}
          params={{ status: r.status, kind: r.kind ?? undefined }}
          page={r.page}
          pageCount={Math.max(1, Math.ceil(r.total / r.pageSize))}
          total={r.total}
        />
      </div>
    </>
  );
}
