import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { HideForm, RecognitionForm } from "@/components/engagement/forms";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { recognitionWall } from "@/modules/engagement/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { hideRecognitionAction, recognizeAction } from "../hr/engagement/actions";

/** Thank-yous between colleagues (ADR-127). */
export default async function RecognitionPage({ params }: PageProps<"/o/[orgSlug]/recognition">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const wall = await recognitionWall(ctx).catch(() => null);
  if (!wall) notFound();
  const [t, format] = await Promise.all([getTranslations("engagement"), getFormatter()]);
  return (
    <>
      <PageHeader title={t("wall")} description={t("wallHint")} />
      <div className="space-y-6">
        {wall.canGive ? (
          <Card title={t("recognizeTitle")}>
            <RecognitionForm
              action={recognizeAction.bind(null, orgSlug)}
              colleagues={wall.colleagues.map((c) => ({
                value: c.id,
                label: `${c.firstName} ${c.lastName} (${c.branch.code})`,
              }))}
            />
          </Card>
        ) : null}
        {wall.posts.length === 0 ? (
          <EmptyState title={t("noPosts")} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="recognition-wall">
            {wall.posts.map((p) => (
              <li key={p.id}>
                <Card>
                  <div className={`space-y-2 text-sm ${p.hiddenAt ? "opacity-60" : ""}`}>
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge tone="success">{t(`values.${p.value}`)}</Badge>
                      <span className="font-medium">
                        {p.to.firstName} {p.to.lastName}
                      </span>
                      <span className="text-muted">{p.to.branch.code}</span>
                    </p>
                    <p className="whitespace-pre-wrap">{p.message}</p>
                    <p className="text-muted text-xs">
                      {t("from", { name: `${p.from.firstName} ${p.from.lastName}` })} ·{" "}
                      {format.dateTime(p.createdAt, { dateStyle: "medium" })}
                    </p>
                    {p.hiddenAt ? (
                      <p className="text-danger text-xs">
                        {t("hidden", { reason: p.hiddenReason ?? "" })}
                      </p>
                    ) : null}
                    {p.canHide ? (
                      <HideForm action={hideRecognitionAction.bind(null, orgSlug, p.id)} />
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
