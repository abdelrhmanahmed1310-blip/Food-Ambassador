import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ApproveDocumentForm, DraftForm } from "@/components/foodsafety/document-forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ReasonForm } from "@/components/procurement/forms";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getFsDocument } from "@/modules/foodsafety/documents";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  approveDocumentAction,
  confirmReadAction,
  newDocumentVersionAction,
  saveDraftAction,
  withdrawDocumentAction,
} from "../actions";

export default async function DocumentPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/documents/[documentId]">) {
  const { orgSlug, documentId } = await params;
  if (!isUuid(documentId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const view = await notFoundOnAppError(getFsDocument(ctx, documentId));
  const { document: doc, current, draft, history, can } = view;
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const when = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone }) : "—";
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const today = businessDate(ctx.timeZone);

  return (
    <>
      <PageHeader
        title={`${doc.code} — ${doc.title}`}
        description={`${t(`fsDocs.types.${doc.type}`)} · ${doc.branch ? `${doc.branch.code} — ${doc.branch.name}` : t("fsDocs.allBranches")}`}
        actions={
          doc.withdrawnAt ? (
            <Badge tone="muted">{t("fsDocs.withdrawn")}</Badge>
          ) : current ? (
            <Badge tone="success">{t("fsDocs.inForceV", { version: current.version })}</Badge>
          ) : (
            <Badge tone="warning">{t("fsDocs.notApproved")}</Badge>
          )
        }
      />
      <div className="space-y-6">
        {doc.withdrawnAt ? (
          <Alert tone="info">
            {t("fsDocs.withdrawnNote", {
              date: when(doc.withdrawnAt),
              reason: doc.withdrawReason ?? "",
            })}
          </Alert>
        ) : null}
        {view.reviewDue ? <Alert tone="error">{t("fsDocs.reviewOverdue")}</Alert> : null}

        {current ? (
          <Card title={t("fsDocs.inForceV", { version: current.version })}>
            <DescriptionList
              items={[
                { label: t("fsDocs.effectiveFrom"), value: day(current.effectiveFrom) },
                { label: t("fsDocs.reviewDueOn"), value: day(current.reviewDueOn) },
                {
                  label: t("fsDocs.writtenBy"),
                  value: `${current.author ?? "—"} · ${when(current.createdAt)}`,
                },
                {
                  label: t("fsDocs.approvedBy"),
                  value: `${current.approver ?? "—"} · ${when(current.approvedAt)}`,
                },
                ...(current.changeSummary
                  ? [{ label: t("fsDocs.changeSummary"), value: current.changeSummary }]
                  : []),
              ]}
            />
            <div
              className="border-border mt-4 rounded-md border p-4 text-sm whitespace-pre-wrap"
              data-testid="fs-doc-content"
            >
              {current.content}
            </div>
            <div className="mt-4">
              <AttachmentsCard
                ctx={ctx}
                orgSlug={orgSlug}
                entityType="FS_DOCUMENT_VERSION"
                entityId={current.id}
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {view.readByMe ? (
                <Badge tone="success">{t("fsDocs.youRead")}</Badge>
              ) : can.confirmRead ? (
                <ConfirmActionButton
                  action={confirmReadAction.bind(null, orgSlug, doc.id)}
                  label={t("fsDocs.confirmRead")}
                  variant="primary"
                />
              ) : null}
              {can.newVersion ? (
                <ConfirmActionButton
                  action={newDocumentVersionAction.bind(null, orgSlug, doc.id)}
                  label={t("fsDocs.newVersion")}
                  variant="secondary"
                />
              ) : null}
            </div>
            <details className="mt-4">
              <summary className="text-primary cursor-pointer text-sm">
                {t("fsDocs.readers", { count: current.readers.length })}
              </summary>
              <ul className="mt-2 text-sm">
                {current.readers.map((r, i) => (
                  <li key={i}>
                    {r.name ?? "—"} <span className="text-muted text-xs">· {when(r.readAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        ) : null}

        {draft ? (
          <Card title={t("fsDocs.draftV", { version: draft.version })}>
            <p className="text-muted mb-3 text-xs">
              {t("fsDocs.draftBy", { name: draft.author ?? "—", date: when(draft.updatedAt) })}
            </p>
            {can.edit ? (
              <DraftForm
                action={saveDraftAction.bind(null, orgSlug, doc.id)}
                defaults={{
                  title: doc.title,
                  content: draft.content,
                  changeSummary: draft.changeSummary ?? undefined,
                }}
              />
            ) : (
              <div className="border-border rounded-md border p-4 text-sm whitespace-pre-wrap">
                {draft.content}
              </div>
            )}
            <div className="mt-4">
              <AttachmentsCard
                ctx={ctx}
                orgSlug={orgSlug}
                entityType="FS_DOCUMENT_VERSION"
                entityId={draft.id}
              />
            </div>
            {can.approve ? (
              <div className="mt-4">
                <ApproveDocumentForm
                  action={approveDocumentAction.bind(null, orgSlug, doc.id)}
                  today={today}
                  review={addDays(today, 365)}
                />
              </div>
            ) : can.edit ? (
              <p className="text-muted mt-3 text-xs">{t("fsDocs.approverHint")}</p>
            ) : null}
          </Card>
        ) : null}

        {history.length > 0 ? (
          <Card title={t("fsDocs.history")}>
            <ul className="divide-border divide-y text-sm">
              {history.map((v) => (
                <li key={v.id} className="py-3">
                  <details>
                    <summary className="cursor-pointer">
                      <span className="ltr-value font-medium">v{v.version}</span> ·{" "}
                      {day(v.effectiveFrom)} – {when(v.supersededAt)}
                      {v.changeSummary ? (
                        <span className="text-muted"> · {v.changeSummary}</span>
                      ) : null}
                      <span className="text-muted text-xs">
                        {" "}
                        · {t("fsDocs.approvedByShort", { name: v.approver ?? "—" })}
                      </span>
                    </summary>
                    <div className="border-border mt-2 rounded-md border p-3 whitespace-pre-wrap">
                      {v.content}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {can.withdraw ? (
          <Card title={t("fsDocs.withdrawTitle")}>
            <p className="text-muted mb-3 text-xs">{t("fsDocs.withdrawHint")}</p>
            <div className="max-w-md">
              <ReasonForm
                action={withdrawDocumentAction.bind(null, orgSlug, doc.id)}
                label={t("fsDocs.withdrawReason")}
                submitLabel={t("fsDocs.withdraw")}
                variant="danger"
              />
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
