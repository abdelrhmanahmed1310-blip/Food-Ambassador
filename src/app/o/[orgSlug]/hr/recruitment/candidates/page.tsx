import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CandidateForm } from "@/components/recruitment/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canViewRecruitment, listCandidates } from "@/modules/recruitment/service";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createCandidateAction } from "../actions";

/** Candidates (ADR-129). */
export default async function CandidatesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/recruitment/candidates">) {
  const { orgSlug } = await params;
  const { q } = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewRecruitment(ctx)) notFound();
  const [t, list] = await Promise.all([getTranslations("recruitment"), listCandidates(ctx, q)]);
  const base = `/o/${orgSlug}/hr/recruitment`;
  const canCreate =
    holdsAnyGrant(ctx.grants, "recruitment.manage") || holdsAnyGrant(ctx.grants, "hr.manage");
  return (
    <>
      <PageHeader title={t("candidates")} description={t("candidatesHint")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block font-medium">{t("search")}</span>
            <input
              name="q"
              defaultValue={typeof q === "string" ? q : ""}
              className="border-border bg-surface rounded-lg border px-3 py-2"
            />
          </label>
          <button type="submit" className="border-border rounded-lg border px-3 py-2 text-sm">
            {t("search")}
          </button>
        </form>
        {list.length === 0 ? (
          <EmptyState title={t("noCandidates")} />
        ) : (
          <Table label={t("candidates")}>
            <thead>
              <tr>
                <Th>{t("candidate")}</Th>
                <Th>{t("source")}</Th>
                <Th>{t("applications")}</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`${base}/candidates/${c.id}`} className="font-medium underline">
                      {c.erasedAt ? t("erasedName") : `${c.firstName} ${c.lastName}`}
                    </Link>
                    {c.email ? <span className="text-muted block text-xs">{c.email}</span> : null}
                  </Td>
                  <Td>{t(`sources.${c.source}`)}</Td>
                  <Td>
                    {c.applications.map((a, i) => (
                      <span key={i} className="me-2 inline-block">
                        {a.opening.number} <Badge tone="neutral">{t(`stages.${a.stage}`)}</Badge>
                      </span>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canCreate ? (
          <Card title={t("createCandidate")}>
            <CandidateForm action={createCandidateAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
