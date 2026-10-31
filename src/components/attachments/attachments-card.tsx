import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Card } from "@/components/ui/primitives";
import { listAttachments, type AttachmentEntity } from "@/modules/attachments/service";
import type { TenantContext } from "@/modules/tenancy/context";
import {
  removeAttachmentAction,
  uploadAttachmentAction,
} from "@/app/o/[orgSlug]/attachments/actions";
import { AttachmentUploadForm } from "./upload-form";

/** Files on a document (ADR-051): list, download, add, and remove a mistaken upload. */
export async function AttachmentsCard({
  ctx,
  orgSlug,
  entityType,
  entityId,
}: {
  ctx: TenantContext;
  orgSlug: string;
  entityType: AttachmentEntity;
  entityId: string;
}) {
  const [t, format, files] = await Promise.all([
    getTranslations("attachments"),
    getFormatter(),
    listAttachments(ctx, entityType, entityId),
  ]);
  if (files.items.length === 0 && !files.canUpload) return null;
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <Card title={t("title")}>
      <div className="space-y-4" data-testid="attachments">
        {files.items.length === 0 ? (
          <p className="text-muted text-sm">{t("none")}</p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {files.items.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {f.purgedAt ? (
                    <bdi className="text-muted">{f.fileName}</bdi>
                  ) : (
                    <a
                      href={`/o/${orgSlug}/attachments/${f.id}`}
                      className="text-primary hover:underline"
                    >
                      <bdi>{f.fileName}</bdi>
                    </a>
                  )}{" "}
                  <span className="text-muted text-xs">
                    · {kb(f.sizeBytes)} · <bdi>{f.uploadedBy ?? "—"}</bdi> ·{" "}
                    {format.dateTime(f.uploadedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}{" "}
                    ·{" "}
                    {f.purgedAt
                      ? t("purged")
                      : t("keptUntil", { date: f.retainUntil.toISOString().slice(0, 10) })}
                  </span>
                </span>
                {f.canRemove ? (
                  <ConfirmActionButton
                    action={removeAttachmentAction.bind(null, orgSlug, f.id)}
                    label={t("remove")}
                    confirmMessage={t("removeConfirm")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {files.canUpload ? (
          <AttachmentUploadForm
            action={uploadAttachmentAction.bind(null, orgSlug, entityType, entityId)}
          />
        ) : null}
      </div>
    </Card>
  );
}
