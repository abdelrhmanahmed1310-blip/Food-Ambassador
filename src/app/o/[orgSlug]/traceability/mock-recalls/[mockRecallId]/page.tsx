import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import {
  CancelMockRecallForm,
  CompleteMockRecallForm,
  ElapsedClock,
} from "@/components/traceability/mock-recall-forms";
import {
  Alert,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { splitElapsed } from "@/modules/traceability/mock-recall-rules";
import { getMockRecall } from "@/modules/traceability/mock-recalls";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { cancelMockRecallAction, completeMockRecallAction } from "../actions";
import { MockRecallBadge } from "../badges";

export default async function MockRecallPage({
  params,
}: PageProps<"/o/[orgSlug]/traceability/mock-recalls/[mockRecallId]">) {
  const { orgSlug, mockRecallId } = await params;
  if (!isUuid(mockRecallId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const d = await notFoundOnAppError(getMockRecall(ctx, mockRecallId));
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const manage = hasPermission(ctx.grants, "recalls.manage");
  const unit = d.lot.product.baseUom.code;
  const q = (v: { toString(): string }) => `${fmt(v)} ${unit}`;
  const dt = (v: Date) =>
    format.dateTime(v, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  const place = (c: (typeof d.counts)[number]) =>
    `${c.warehouse.code}${c.locationCode ? ` / ${c.locationCode}` : ""} · ${t(`inventory.statuses.${c.stockStatus}`)}`;
  const passed = d.outcome ? d.outcome.problems.length === 0 : null;
  return (
    <>
      <PageHeader
        title={`${d.number} — ${d.lot.lotCode}`}
        description={
          <>
            <Link
              href={`/o/${orgSlug}/traceability/lots/${d.lot.id}`}
              className="text-primary hover:underline"
            >
              {d.lot.product.sku} — {productName(d.lot.product, locale)}
            </Link>
            {" · "}
            {d.scenario}
          </>
        }
        actions={<MockRecallBadge status={d.status} passed={passed} />}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("mockRecalls.branch"), value: `${d.branch.code} — ${d.branch.name}` },
              {
                label: t("mockRecalls.started"),
                value: `${dt(d.startedAt)}${d.startedBy ? ` · ${d.startedBy}` : ""}`,
              },
              {
                label: d.status === "RUNNING" ? t("mockRecalls.running") : t("mockRecalls.elapsed"),
                value:
                  d.status === "RUNNING" ? (
                    <ElapsedClock startedAt={d.startedAt.toISOString()} />
                  ) : d.elapsedSeconds !== null ? (
                    t("mockRecalls.hoursMinutes", splitElapsed(d.elapsedSeconds))
                  ) : (
                    "—"
                  ),
              },
              {
                label: t("mockRecalls.target"),
                value: d.targetMinutes
                  ? `${d.targetMinutes}${
                      d.withinTarget === null
                        ? ""
                        : ` · ${d.withinTarget ? t("mockRecalls.withinTarget") : t("mockRecalls.targetMissed")}`
                    }`
                  : t("mockRecalls.noTarget"),
              },
              ...(d.completedAt
                ? [
                    {
                      label: t("mockRecalls.completedBy"),
                      value: `${dt(d.completedAt)}${d.completedBy ? ` · ${d.completedBy}` : ""}`,
                    },
                    {
                      label: t("mockRecalls.accounted"),
                      value: (
                        <span className="ltr-value tabular-nums">
                          {d.accountedPercent ? `${d.accountedPercent.toString()} %` : "—"}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(d.nonConformance
                ? [
                    {
                      label: t("mockRecalls.nonConformance"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/food-safety/non-conformances/${d.nonConformance.id}`}
                          className="ltr-value text-primary font-mono text-xs hover:underline"
                        >
                          {d.nonConformance.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(d.cancelNote
                ? [{ label: t("mockRecalls.cancelNote"), value: d.cancelNote }]
                : []),
              ...(d.findings ? [{ label: t("mockRecalls.findings"), value: d.findings }] : []),
            ]}
          />
        </Card>

        {d.outcome && d.outcome.problems.length > 0 ? (
          <Alert tone="error">
            <p className="font-medium">{t("mockRecalls.problemsTitle")}</p>
            <ul className="list-disc ps-5">
              {d.outcome.problems.map((p) => (
                <li key={p}>{t(`mockRecalls.problems.${p}`)}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <Card title={t("mockRecalls.bookTitle")}>
          <DescriptionList
            items={[
              {
                label: t("mockRecalls.received"),
                value: <span className="ltr-value tabular-nums">{q(d.receivedQuantity)}</span>,
              },
              {
                label: t("mockRecalls.leftBusiness"),
                value: <span className="ltr-value tabular-nums">{q(d.exitedQuantity)}</span>,
              },
              {
                label: t("mockRecalls.bookOnHand"),
                value: <span className="ltr-value tabular-nums">{q(d.onHandQuantity)}</span>,
              },
              { label: t("mockRecalls.gaps"), value: String(d.gapCount) },
              { label: t("mockRecalls.suppliers"), value: String(d.supplierCount) },
            ]}
          />
        </Card>

        {d.status !== "RUNNING" && d.counts.length > 0 ? (
          <Table label={t("mockRecalls.countsTitle")}>
            <thead>
              <tr>
                <Th>{t("mockRecalls.place")}</Th>
                <Th>{t("mockRecalls.book")}</Th>
                <Th>{t("mockRecalls.found")}</Th>
                <Th>{t("mockRecalls.difference")}</Th>
                <Th>{t("common.note")}</Th>
              </tr>
            </thead>
            <tbody>
              {d.counts.map((c) => (
                <tr key={c.id}>
                  <Td>{place(c)}</Td>
                  <Td className="ltr-value tabular-nums">{q(c.bookQuantity)}</Td>
                  <Td className="ltr-value tabular-nums">
                    {c.foundQuantity === null ? "—" : q(c.foundQuantity)}
                  </Td>
                  <Td className="ltr-value tabular-nums">
                    {c.foundQuantity === null
                      ? "—"
                      : q(
                          new Decimal(c.foundQuantity.toString()).minus(
                            new Decimal(c.bookQuantity.toString()),
                          ),
                        )}
                  </Td>
                  <Td>{c.note ?? ""}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}

        {d.status === "RUNNING" && manage ? (
          <>
            <Card title={t("mockRecalls.countsTitle")}>
              <CompleteMockRecallForm
                action={completeMockRecallAction.bind(null, orgSlug, d.id)}
                counts={d.counts.map((c) => ({
                  id: c.id,
                  label: place(c),
                  book: q(c.bookQuantity),
                }))}
              />
            </Card>
            <Card title={t("mockRecalls.cancel")}>
              <CancelMockRecallForm action={cancelMockRecallAction.bind(null, orgSlug, d.id)} />
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
