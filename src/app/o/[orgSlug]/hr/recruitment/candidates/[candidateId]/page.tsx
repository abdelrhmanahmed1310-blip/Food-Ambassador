import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getCandidate } from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { eraseCandidateAction } from "../../actions";
import { STAGE_TONE } from "../../status";

/** A candidate: contact, applications, CVs, erasure (ADR-129). */
export default async function CandidatePage({
  params,
}: PageProps<"/o/[orgSlug]/hr/recruitment/candidates/[candidateId]">) {
  const { orgSlug, candidateId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(candidateId)) notFound();
  const [t, r] = await Promise.all([
    getTranslations("recruitment"),
    getCandidate(ctx, candidateId),
  ]);
  const c = r.candidate;
  const base = `/o/${orgSlug}/hr/recruitment`;
  return (
    <>
      <PageHeader
        title={c.erasedAt ? t("erasedName") : `${c.firstName} ${c.lastName}`}
        description={t(`sources.${c.source}`)}
      />
      <div className="space-y-6">
        {c.erasedAt ? (
          <Alert tone="info">{t("erasedHint")}</Alert>
        ) : (
          <Card title={t("contact")}>
            <DescriptionList
              items={[
                { label: t("email"), value: c.email ?? "—" },
                { label: t("phone"), value: c.phone ?? "—" },
                ...(c.note ? [{ label: t("note"), value: c.note }] : []),
              ]}
            />
          </Card>
        )}
        <Card title={t("applications")}>
          {c.applications.length === 0 ? (
            <p className="text-muted text-sm">{t("noApplications")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {c.applications.map((a) => (
                <li key={a.id}>
                  <Link href={`${base}/applications/${a.id}`} className="underline">
                    {a.opening.number} · {a.opening.jobTitle} · {a.opening.branch.code}
                  </Link>{" "}
                  <Badge tone={STAGE_TONE[a.stage]}>{t(`stages.${a.stage}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {!c.erasedAt ? (
          <AttachmentsCard ctx={ctx} orgSlug={orgSlug} entityType="CANDIDATE" entityId={c.id} />
        ) : null}
        {r.can.erase ? (
          <ConfirmActionButton
            action={eraseCandidateAction.bind(null, orgSlug, c.id)}
            label={t("erase")}
            confirmMessage={t("eraseConfirm")}
          />
        ) : null}
      </div>
    </>
  );
}
