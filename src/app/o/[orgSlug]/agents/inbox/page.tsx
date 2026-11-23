import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ActionForm, TextField } from "@/components/forms/fields";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { canSeeAgents, listProposals } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { decideProposalAction } from "../actions";

const STATUSES = ["OPEN", "APPROVED", "REJECTED", "SUPERSEDED"] as const;

type Detail = {
  orderNumber?: string;
  supplier?: string;
  warehouse?: string;
  total?: string;
  currency?: string;
  lines?:
    number | Array<{ sku: string; name: string; quantity: string; unit: string; price: string }>;
};

/** What the agents propose, for a person to approve or reject (ADR-140). */
export default async function AgentInboxPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/agents/inbox">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeAgents(ctx)) notFound();
  const [t, format, data] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    listProposals(ctx, { status: typeof sp.status === "string" ? sp.status : undefined }),
  ]);
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title={t("inboxTitle")} description={t("inboxIntro")} />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}/agents/inbox?status=${s}`}
            aria-current={data.status === s ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${data.status === s ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
          >
            {t(`proposalStatus.${s}`)}
          </Link>
        ))}
      </div>
      {data.items.length === 0 ? (
        <EmptyState title={t("inboxEmpty")} />
      ) : (
        <div className="space-y-4">
          {data.items.map((p) => {
            const d = p.detail as Detail;
            return (
              <Card key={p.id} title={p.title}>
                <div className="space-y-3 text-sm" data-testid="proposal">
                  <p className="text-muted">
                    {t(`kinds.${p.agent.kind as "REPLENISHMENT"}.name`)} ·{" "}
                    {t(`proposalKinds.${p.kind as "REORDER"}`)} ·{" "}
                    {format.dateTime(p.createdAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}{" "}
                    <Badge
                      tone={
                        p.status === "OPEN"
                          ? "warning"
                          : p.status === "APPROVED"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {t(`proposalStatus.${p.status}`)}
                    </Badge>
                  </p>
                  {p.kind === "PURCHASE_ORDER" && p.entityId ? (
                    <p>
                      <Link
                        href={`${base}/purchasing/orders/${p.entityId}`}
                        className="text-primary hover:underline"
                      >
                        {t("draftOrder", { number: d.orderNumber ?? "" })}
                      </Link>{" "}
                      ·{" "}
                      {t("linesTotal", {
                        lines: Number(d.lines ?? 0),
                        total: d.total ?? "",
                        currency: d.currency ?? "",
                      })}
                    </p>
                  ) : null}
                  {Array.isArray(d.lines) ? (
                    <ul className="divide-border divide-y">
                      {d.lines.map((l) => (
                        <li key={l.sku} className="flex justify-between gap-2 py-1">
                          <span>
                            <span className="ltr-value font-mono text-xs">{l.sku}</span> — {l.name}
                          </span>
                          <span className="ltr-value tabular-nums">
                            {l.quantity} {l.unit} × {l.price}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {p.status === "OPEN" ? (
                    <div className="flex flex-wrap items-start gap-3">
                      <ActionForm
                        action={decideProposalAction.bind(null, orgSlug, p.id, "APPROVE")}
                        submitLabel={
                          p.kind === "PURCHASE_ORDER" ? t("approveSubmit") : t("approveDraft")
                        }
                        pendingLabel={t("saving")}
                        className="space-y-2"
                      >
                        <span />
                      </ActionForm>
                      <ActionForm
                        action={decideProposalAction.bind(null, orgSlug, p.id, "REJECT")}
                        submitLabel={t("reject")}
                        pendingLabel={t("saving")}
                        submitVariant="secondary"
                        className="flex flex-wrap items-end gap-2"
                      >
                        <TextField name="note" label={t("rejectNote")} />
                      </ActionForm>
                    </div>
                  ) : p.decisionNote ? (
                    <p className="text-muted">{p.decisionNote}</p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
