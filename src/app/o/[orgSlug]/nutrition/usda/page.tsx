import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ActionForm, CheckboxField, TextField } from "@/components/forms/fields";
import { Pagination } from "@/components/ui/pagination";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { listSyncJobs, syncStatus } from "@/modules/nutrition/engine/sync";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  importUsdaAction,
  requestSyncAction,
  retrySyncAction,
  updateSettingsAction,
} from "../actions";
import { Tabs } from "../tabs";

const tone = (s: string) =>
  s === "SUCCEEDED" ? "success" : s === "FAILED" ? "danger" : s === "PARTIAL" ? "warning" : "muted";

/** USDA FoodData Central: connection, refresh policy, sync jobs (ADR-132). The key itself is server configuration. */
export default async function UsdaPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/usda">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const page = typeof sp.page === "string" ? sp.page : "1";
  const [t, format, s, jobs] = await Promise.all([
    getTranslations("nutritionEngine"),
    getFormatter(),
    syncStatus(ctx),
    listSyncJobs(ctx, { page }),
  ]);
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  // Sync runs and the refresh policy are organization-wide; a site-scoped manager imports only.
  const manageAll = manage && accessibleScope(ctx.grants, "nutrition.manage").all;
  const when = (v: Date | null) =>
    v
      ? format.dateTime(v, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  return (
    <>
      <PageHeader title={t("usdaTitle")} description={t("usdaIntro")} />
      <Tabs orgSlug={orgSlug} current="usda" />
      <div className="space-y-6">
        <Card title={t("connection")}>
          {s.usdaConfigured ? (
            <Alert tone="success">{t("usdaConfiguredNote")}</Alert>
          ) : (
            <Alert tone="info">{t("usdaNotConfigured")}</Alert>
          )}
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">{t("lastSync")}</dt>
              <dd className="ltr-value">{when(s.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("running")}</dt>
              <dd className="ltr-value">{s.running}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("lastReleaseCheck")}</dt>
              <dd className="ltr-value">{when(s.settings.lastReleaseCheckAt)}</dd>
            </div>
          </dl>
          {Object.keys(s.settings.releases).length > 0 ? (
            <div className="mt-3 text-sm">
              <p className="text-muted">{t("releases")}</p>
              <ul className="ltr-value">
                {Object.entries(s.settings.releases).map(([k, v]) => (
                  <li key={k}>
                    {k}: {v}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {manage ? (
          <Card title={t("importByIds")}>
            <ActionForm action={importUsdaAction.bind(null, orgSlug)} submitLabel={t("import")}>
              <TextField
                name="fdcIds"
                label={t("fdcIds")}
                hint={t("fdcIdsHint")}
                required
                dir="ltr"
              />
            </ActionForm>
          </Card>
        ) : null}

        {manageAll ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={t("syncJobsRequest")}>
              <div className="space-y-4">
                <ActionForm
                  action={requestSyncAction.bind(null, orgSlug)}
                  submitLabel={t("queueImport")}
                >
                  <input type="hidden" name="kind" value="IMPORT" />
                  <TextField
                    name="fdcIds"
                    label={t("fdcIdsBulk")}
                    hint={t("fdcIdsBulkHint")}
                    required
                    dir="ltr"
                  />
                </ActionForm>
                <div className="flex flex-wrap gap-3">
                  <ConfirmActionButton
                    action={requestSyncAction.bind(null, orgSlug)}
                    label={t("queueRefresh")}
                    variant="secondary"
                    hidden={{ kind: "REFRESH" }}
                  />
                  <ConfirmActionButton
                    action={requestSyncAction.bind(null, orgSlug)}
                    label={t("queueReleaseCheck")}
                    variant="secondary"
                    hidden={{ kind: "RELEASE_CHECK" }}
                  />
                </div>
              </div>
            </Card>
            <Card title={t("refreshPolicy")}>
              <ActionForm action={updateSettingsAction.bind(null, orgSlug)} submitLabel={t("save")}>
                <CheckboxField
                  name="autoRefresh"
                  label={t("autoRefresh")}
                  defaultChecked={s.settings.autoRefresh}
                />
                <TextField
                  name="refreshDays"
                  label={t("refreshDays")}
                  defaultValue={String(s.settings.refreshDays)}
                  inputMode="numeric"
                  dir="ltr"
                  required
                />
              </ActionForm>
            </Card>
          </div>
        ) : null}

        <Card title={t("jobs")}>
          {jobs.items.length === 0 ? (
            <EmptyState title={t("noJobs")} />
          ) : (
            <Table label={t("jobs")}>
              <thead>
                <tr>
                  <Th>{t("requested")}</Th>
                  <Th>{t("kind")}</Th>
                  <Th>{t("status")}</Th>
                  <Th>{t("counts")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {jobs.items.map((j) => {
                  const errors = Array.isArray(j.errors)
                    ? (j.errors as Array<{ ref?: string; message?: string }>)
                    : [];
                  return (
                    <tr key={j.id} data-testid="sync-job">
                      <Td className="ltr-value">{when(j.createdAt)}</Td>
                      <Td>{t(`syncKinds.${j.kind}`)}</Td>
                      <Td>
                        <Badge tone={tone(j.status)}>{t(`syncStatuses.${j.status}`)}</Badge>
                      </Td>
                      <Td className="text-xs">
                        {t("jobCounts", {
                          processed: j.processed,
                          total: j.total,
                          created: j.created,
                          updated: j.updated,
                          unchanged: j.unchanged,
                          failed: j.failed,
                        })}
                        {errors.length > 0 ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer">
                              {t("errors", { count: errors.length })}
                            </summary>
                            <ul className="ltr-value mt-1 space-y-0.5">
                              {errors.slice(0, 20).map((e, i) => (
                                <li key={i}>
                                  {e.ref ?? "?"}: {e.message ?? ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </Td>
                      <Td>
                        {manageAll &&
                        (j.status === "FAILED" || j.status === "PARTIAL") &&
                        j.kind !== "BULK_FILE" ? (
                          <ConfirmActionButton
                            action={retrySyncAction.bind(null, orgSlug, j.id)}
                            label={t("retry")}
                            variant="secondary"
                          />
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <Pagination
            basePath={`/o/${orgSlug}/nutrition/usda`}
            params={{}}
            page={jobs.page}
            pageCount={Math.max(1, Math.ceil(jobs.total / jobs.pageSize))}
            total={jobs.total}
          />
        </Card>

        <Card title={t("bulkFiles")}>
          <p className="text-sm">{t("bulkFilesHint")}</p>
          <pre className="ltr-value bg-surface-muted mt-2 overflow-x-auto rounded-md p-3 text-xs">
            pnpm nutrition:import-usda --org {orgSlug} --user you@example.com
            FoodData_Central_foundation_food_json.json
          </pre>
        </Card>
      </div>
    </>
  );
}
