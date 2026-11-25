import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { REJECTION_REASONS } from "@/modules/agents/rules";
import { canSeeAgents, listProposals } from "@/modules/agents/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { pausedLines } from "@/modules/agents/line-drops";
import {
  decideProposalAction,
  dropLineAction,
  liftLinePauseAction,
  liftPauseAction,
  stopActionAction,
} from "../actions";

const STATUSES = ["OPEN", "SCHEDULED", "APPROVED", "REJECTED", "SUPERSEDED"] as const;

type Detail = {
  orderNumber?: string;
  supplier?: string;
  warehouse?: string;
  total?: string;
  currency?: string;
  lines?:
    number | Array<{ sku: string; name: string; quantity: string; unit: string; price: string }>;
};

/** A credit request for an invoice exception (ADR-142). */
type CreditDetail = {
  invoiceNumber: string;
  supplierInvoiceNo: string;
  total: string;
  currency: string;
  lines: Array<{
    lineNo: number;
    sku: string | null;
    reason: "PRICE" | "QUANTITY";
    amount: string;
    invoicedPrice: string;
    orderedPrice: string | null;
  }>;
};
type NcDetail = {
  branch: string;
  severity: string;
  reason: "EXPIRED_STOCK" | "CALIBRATION_OVERDUE";
  sku?: string;
  lot?: string;
  expiredOn?: string;
  warehouses?: string;
  quantity?: string;
  equipment?: string;
  equipmentName?: string;
  nonConformanceId?: string;
  nonConformance?: string;
};
type PriceDetail = {
  dish: string;
  costPerPortion: string;
  price: string;
  newPrice: string;
  foodCostPercent: string;
  newFoodCostPercent: string;
  targetPercent: string;
  effectiveInDays: number;
  currency: string;
  effectiveFrom?: string;
};

const APPROVE_LABEL = {
  PURCHASE_ORDER: "approveSubmit",
  REORDER: "approveDraft",
  CREDIT_REQUEST: "approveCredit",
  RAISE_NC: "approveNc",
  PRICE_CHANGE: "approvePrice",
  FOLLOW_UP: "approveFollowUp",
} as const;

/** What the agents propose, for a person to approve or reject (ADR-140). */
export default async function AgentInboxPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/agents/inbox">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeAgents(ctx)) notFound();
  const [t, format, locale, data, paused] = await Promise.all([
    getTranslations("agents"),
    getFormatter(),
    getLocale(),
    listProposals(ctx, { status: typeof sp.status === "string" ? sp.status : undefined }),
    pausedLines(ctx),
  ]);
  const reasonOptions = REJECTION_REASONS.map((r) => ({
    value: r,
    label: t(`rejectionReasons.${r}`),
  }));
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title={t("inboxTitle")} description={t("inboxIntro")} />
      {paused.length ? (
        <Card title={t("pausedTitle")}>
          <ul className="divide-border divide-y text-sm" data-testid="paused-lines">
            {paused.map((x) => (
              <li
                key={`${x.warehouseId}:${x.productId}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  <span className="ltr-value font-mono text-xs">{x.warehouse}</span> ·{" "}
                  <span className="ltr-value font-mono text-xs">{x.sku}</span> — {x.name} ·{" "}
                  {t("pausedUntil", {
                    date: format.dateTime(x.until, { dateStyle: "medium", timeZone: ctx.timeZone }),
                  })}
                </span>
                <ActionForm
                  action={liftLinePauseAction.bind(null, orgSlug, x.warehouseId, x.productId)}
                  submitLabel={t("liftPause")}
                  pendingLabel={t("saving")}
                  submitVariant="secondary"
                >
                  <span />
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
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
                  {p.kind === "CREDIT_REQUEST" ? <CreditRequest p={p} base={base} t={t} /> : null}
                  {p.kind === "RAISE_NC" ? <RaiseNc p={p} base={base} t={t} /> : null}
                  {p.kind === "PRICE_CHANGE" ? <PriceChange p={p} base={base} t={t} /> : null}
                  {p.kind === "FOLLOW_UP" ? (
                    <FollowUp p={p} base={base} t={t} lang={locale === "ar" ? "ar" : "en"} />
                  ) : null}
                  {(p.kind === "REORDER" || p.kind === "PURCHASE_ORDER") &&
                  Array.isArray(d.lines) ? (
                    <ul className="divide-border divide-y">
                      {d.lines.map((l) => (
                        <li key={l.sku} className="space-y-1 py-1">
                          <div className="flex justify-between gap-2">
                            <span>
                              <span className="ltr-value font-mono text-xs">{l.sku}</span> —{" "}
                              {l.name}
                            </span>
                            <span className="ltr-value tabular-nums">
                              {l.quantity} {l.unit} × {l.price}
                            </span>
                          </div>
                          {p.kind === "REORDER" &&
                          p.status === "OPEN" &&
                          Array.isArray(d.lines) &&
                          d.lines.length > 1 ? (
                            <details data-testid={`drop-${l.sku}`}>
                              <summary className="text-primary cursor-pointer text-xs">
                                {t("dropLine")}
                              </summary>
                              <ActionForm
                                action={dropLineAction.bind(null, orgSlug, p.id, l.sku)}
                                submitLabel={t("dropLine")}
                                pendingLabel={t("saving")}
                                submitVariant="secondary"
                                className="flex flex-wrap items-end gap-2 pt-2"
                              >
                                <SelectField
                                  name="reason"
                                  label={t("rejectReason")}
                                  placeholder={t("rejectReasonPick")}
                                  options={reasonOptions}
                                />
                                <TextField name="note" label={t("rejectNote")} />
                              </ActionForm>
                            </details>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {p.status === "SCHEDULED" && p.scheduledFor ? (
                    <div
                      className="flex flex-wrap items-center gap-3"
                      data-testid="scheduled-action"
                    >
                      <p className="text-warning">
                        {t("scheduledFor", {
                          when: format.dateTime(p.scheduledFor, {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone: ctx.timeZone,
                          }),
                        })}
                      </p>
                      <ActionForm
                        action={stopActionAction.bind(null, orgSlug, p.id)}
                        submitLabel={t("stop")}
                        pendingLabel={t("saving")}
                        submitVariant="secondary"
                      >
                        <span />
                      </ActionForm>
                    </div>
                  ) : null}
                  {p.actedByAgent ? <Badge tone="success">{t("actedByAgent")}</Badge> : null}
                  {p.status === "OPEN" &&
                  typeof (p.detail as { actionError?: unknown }).actionError === "string" ? (
                    <p className="text-danger">
                      {t("actionError", {
                        error: String((p.detail as { actionError: string }).actionError),
                      })}
                    </p>
                  ) : null}
                  {p.status === "OPEN" || p.status === "SCHEDULED" ? (
                    <div className="flex flex-wrap items-start gap-3">
                      <ActionForm
                        action={decideProposalAction.bind(null, orgSlug, p.id, "APPROVE")}
                        submitLabel={t(
                          APPROVE_LABEL[p.kind as keyof typeof APPROVE_LABEL] ?? "approveDraft",
                          {
                            days: Number((p.detail as PriceDetail).effectiveInDays ?? 1),
                          },
                        )}
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
                        <SelectField
                          name="reason"
                          label={t("rejectReason")}
                          placeholder={t("rejectReasonPick")}
                          options={reasonOptions}
                        />
                        <TextField name="note" label={t("rejectNote")} />
                      </ActionForm>
                    </div>
                  ) : p.rejectionReason || p.decisionNote ? (
                    <p className="text-muted">
                      {p.rejectionReason
                        ? t(
                            `rejectionReasons.${p.rejectionReason as (typeof REJECTION_REASONS)[number]}`,
                          )
                        : null}
                      {p.rejectionReason && p.decisionNote ? " — " : null}
                      {p.decisionNote}
                    </p>
                  ) : null}
                  {p.status === "REJECTED" &&
                  p.entityId &&
                  !p.pauseLiftedAt &&
                  (p.rejectionReason === "NOT_NEEDED" || p.rejectionReason === "ALREADY_DONE") ? (
                    <div className="flex flex-wrap items-center gap-3" data-testid="lift-pause">
                      <p className="text-muted text-xs">{t("pauseHint")}</p>
                      <ActionForm
                        action={liftPauseAction.bind(null, orgSlug, p.id)}
                        submitLabel={t("liftPause")}
                        pendingLabel={t("saving")}
                        submitVariant="secondary"
                      >
                        <span />
                      </ActionForm>
                    </div>
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

type T = Awaited<ReturnType<typeof getTranslations<"agents">>>;
type P = Awaited<ReturnType<typeof listProposals>>["items"][number];

function CreditRequest({ p, base, t }: { p: P; base: string; t: T }) {
  const d = p.detail as CreditDetail;
  return (
    <>
      <p>
        <Link
          href={`${base}/purchasing/invoices/${p.entityId}`}
          className="text-primary hover:underline"
        >
          {t("creditInvoice", { number: d.invoiceNumber, reference: d.supplierInvoiceNo })}
        </Link>{" "}
        · {t("creditTotal", { total: d.total, currency: d.currency })}
      </p>
      <ul className="divide-border divide-y">
        {d.lines.map((l) => (
          <li key={`${l.lineNo}-${l.reason}`} className="flex justify-between gap-2 py-1">
            <span>
              {t(`creditReasons.${l.reason}`, {
                line: l.lineNo,
                sku: l.sku ?? "—",
                invoiced: l.invoicedPrice,
                ordered: l.orderedPrice ?? "—",
              })}
            </span>
            <span className="ltr-value tabular-nums">{l.amount}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function RaiseNc({ p, base, t }: { p: P; base: string; t: T }) {
  const d = p.detail as NcDetail;
  return (
    <>
      <p>
        {d.reason === "EXPIRED_STOCK"
          ? t("ncExpired", {
              branch: d.branch,
              sku: d.sku ?? "",
              lot: d.lot ?? "",
              date: d.expiredOn ?? "",
              warehouses: d.warehouses ?? "",
              quantity: d.quantity ?? "",
            })
          : t("ncCalibration", {
              branch: d.branch,
              equipment: d.equipment ?? "",
              name: d.equipmentName ?? "",
            })}
      </p>
      <p className="text-muted">{t("ncSeverity", { severity: d.severity })}</p>
      {d.nonConformanceId ? (
        <Link
          href={`${base}/food-safety/non-conformances/${d.nonConformanceId}`}
          className="text-primary hover:underline"
        >
          {t("ncRaised", { number: d.nonConformance ?? "" })}
        </Link>
      ) : null}
    </>
  );
}

function PriceChange({ p, base, t }: { p: P; base: string; t: T }) {
  const d = p.detail as PriceDetail;
  return (
    <>
      <p>
        <Link href={`${base}/recipes/${p.entityId}`} className="text-primary hover:underline">
          {d.dish}
        </Link>{" "}
        ·{" "}
        <span className="ltr-value tabular-nums">
          {t("priceFromTo", { from: d.price, to: d.newPrice, currency: d.currency })}
        </span>
      </p>
      <p className="text-muted">
        {t("foodCostFromTo", {
          from: d.foodCostPercent,
          to: d.newFoodCostPercent,
          target: d.targetPercent,
          cost: d.costPerPortion,
        })}
      </p>
      {d.effectiveFrom ? <p>{t("priceFrom", { date: d.effectiveFrom })}</p> : null}
    </>
  );
}

/** A next step from a Claude investigation, taken on by a person (ADR-149). */
function FollowUp({ p, base, t, lang }: { p: P; base: string; t: T; lang: "en" | "ar" }) {
  const d = p.detail as {
    findingCode: string;
    nextStep: {
      kind: "MESSAGE" | "CHECK" | "CHANGE";
      title: { en: string; ar: string };
      body: { en: string; ar: string };
    };
  };
  return (
    <>
      <p className="font-medium">
        {t(`nextStepKinds.${d.nextStep.kind}`)}: {d.nextStep.title[lang]}
      </p>
      <p className="whitespace-pre-line">{d.nextStep.body[lang]}</p>
      <Link href={`${base}/agents/runs/${p.runId}`} className="text-primary hover:underline">
        {t("fromRun")}
      </Link>
    </>
  );
}
