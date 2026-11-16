import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PosSimulator } from "@/components/pos/simulator";
import { PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { clockIn } from "@/modules/pos/board-rules";
import { simulatorBranches, simulatorData } from "@/modules/pos/simulator";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { AppError } from "@/server/errors";

/**
 * POS simulator (ADR-135): practise and test sales by punching or scanning,
 * and preview menu boards, on the branch's live menu. Nothing is recorded.
 */
export default async function PosSimulatorPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/pos/simulator">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const branches = await simulatorBranches(ctx).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "FORBIDDEN") notFound();
    throw e;
  });
  const t = await getTranslations("simulator");
  if (branches.length === 0)
    return (
      <>
        <PageHeader title={t("title")} description={t("intro")} />
        <p className="text-muted text-sm">{t("noBranches")}</p>
      </>
    );
  const branchId =
    typeof sp.branch === "string" && isUuid(sp.branch) && branches.some((b) => b.id === sp.branch)
      ? sp.branch
      : branches[0].id;
  const data = await simulatorData(ctx, branchId);
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-4">
        {branches.length > 1 ? (
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("branch")}</span>
              <select name="branch" defaultValue={branchId} className={inputClass}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass("secondary")}>
              {t("show")}
            </button>
          </form>
        ) : null}
        <PosSimulator key={branchId} data={data} clock={clockIn(data.timeZone)} />
      </div>
    </>
  );
}
