import { getTranslations } from "next-intl/server";
import { getHaccpPlan } from "@/modules/foodsafety/haccp";
import { letterheadInTx } from "@/modules/documents/service";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { withTenantTx } from "@/server/db/transactions";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The HACCP plan as a document: control points with limits, monitoring, correction and verification (ADR-096). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/food-safety/haccp/[planId]/pdf">,
) {
  const { orgSlug, planId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { plan, steps } = await getHaccpPlan(ctx, planId);
    const seller = await withTenantTx(ctx.organizationId, (tx) => letterheadInTx(tx, ctx, null));
    const [t, f] = await Promise.all([getTranslations("haccp"), pdfFormat()]);
    const rows = steps.flatMap((s) =>
      s.hazards.map((h) => [
        `${s.position}. ${s.name}`,
        `${h.classification}\n${t(`hazardTypes.${h.type}`)}: ${h.description}\n${t("riskScore", { score: h.likelihood * h.severity, l: h.likelihood, s: h.severity })}`,
        h.controlPoint ? h.controlPoint.criticalLimit : (h.controlMeasures ?? "—"),
        h.controlPoint
          ? `${h.controlPoint.monitoring}\n${h.controlPoint.frequency}${h.controlPoint.responsible ? `\n${h.controlPoint.responsible}` : ""}`
          : "—",
        h.controlPoint
          ? `${h.controlPoint.correctiveAction}\n${t("verification")}: ${h.controlPoint.verification}`
          : "—",
      ]),
    );
    const pdf = await renderPdf({
      title: t("pdfTitle"),
      number: `${plan.code} v${plan.version}`,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      party: {
        label: t("name"),
        name: plan.name,
        lines: [plan.scope, ...(plan.intendedUse ? [plan.intendedUse] : [])],
        facts: plan.team ? [[t("team"), plan.team]] : [],
      },
      details: [
        [t("statusLabel"), t(`statuses.${plan.status}`)],
        [t("branch"), plan.branch ? `${plan.branch.code} — ${plan.branch.name}` : t("allBranches")],
        ...(plan.approvedAt
          ? ([
              [t("approvedBy"), `${plan.approvedBy ?? "—"} · ${f.date(plan.approvedAt)}`],
              [t("reviewDueOn"), plan.reviewDueOn ? f.date(plan.reviewDueOn) : "—"],
            ] as Array<[string, string]>)
          : []),
      ],
      columns: [
        { label: t("step"), width: 16 },
        { label: t("hazard"), width: 26 },
        { label: t("criticalLimit"), width: 18 },
        { label: t("monitoring"), width: 20 },
        { label: t("correctiveAction"), width: 20 },
      ],
      rows,
      totals: [],
      notes: plan.status === "DRAFT" ? [t("pdfDraftNote")] : [],
    });
    return pdfResponse(request, pdf, `${plan.code}-v${plan.version}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
