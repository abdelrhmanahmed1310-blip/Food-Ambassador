import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CouponForm, PromotionForm } from "@/components/pos/promotion-forms";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { listPromotions } from "@/modules/pos/promotions";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import {
  archiveCouponAction,
  archivePromotionAction,
  createCouponAction,
  createPromotionAction,
} from "./actions";

/** Promotions and coupons (ADR-067). */
export default async function PromotionsPage({ params }: PageProps<"/o/[orgSlug]/pos/promotions">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.view")) notFound();
  const manage = hasPermission(ctx.grants, "menu.manage");
  const [t, money, data] = await Promise.all([
    getTranslations(),
    moneyFormatter(ctx.baseCurrency),
    listPromotions(ctx),
  ]);
  const today = businessDate(ctx.timeZone);
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
  const named = (x: { name: string; nameAr: string | null }) => x.name;
  const nameOf = new Map([...data.categories, ...data.items].map((x) => [x.id, named(x)]));
  const status = (archived: Date | null, validTo: Date | null) =>
    archived ? (
      <Badge tone="neutral">{t("promotions.archived")}</Badge>
    ) : validTo && iso(validTo) < today ? (
      <Badge tone="warning">{t("promotions.ended")}</Badge>
    ) : (
      <Badge tone="success">{t("promotions.active")}</Badge>
    );
  return (
    <>
      <PageHeader title={t("promotions.title")} description={t("promotions.intro")} />
      <div className="space-y-6">
        <Card title={t("promotions.promotions")}>
          {data.promotions.length === 0 ? (
            <p className="text-muted text-sm">{t("promotions.none")}</p>
          ) : (
            <Table label={t("promotions.promotions")}>
              <thead>
                <tr>
                  <Th>{t("promotions.name")}</Th>
                  <Th>{t("promotions.percent")}</Th>
                  <Th>{t("promotions.appliesTo")}</Th>
                  <Th>{t("promotions.when")}</Th>
                  <Th>{t("pos.status")}</Th>
                  {manage ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {data.promotions.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <bdi>{p.name}</bdi>
                    </Td>
                    <Td className="ltr-value tabular-nums">{p.percent.toFixed()} %</Td>
                    <Td>
                      {[...p.categoryIds, ...p.itemIds]
                        .map((id) => nameOf.get(id) ?? "—")
                        .join(" · ")}
                    </Td>
                    <Td className="text-sm">
                      <span className="ltr-value">
                        {iso(p.validFrom)} → {p.validTo ? iso(p.validTo) : "…"}
                      </span>
                      {p.startTime ? (
                        <span className="ltr-value block">
                          {p.startTime}–{p.endTime}
                        </span>
                      ) : null}
                      {p.weekdays.length > 0 ? (
                        <span className="block">
                          {p.weekdays.map((d) => t(`promotions.weekdayNames.${d}`)).join(" · ")}
                        </span>
                      ) : null}
                      {p.channels.length > 0 ? (
                        <span className="block">
                          {p.channels.map((c) => t(`menu.channels.${c}`)).join(" · ")}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{status(p.archivedAt, p.validTo)}</Td>
                    {manage ? (
                      <Td>
                        {p.archivedAt ? null : (
                          <ConfirmActionButton
                            action={archivePromotionAction.bind(null, orgSlug, p.id)}
                            label={t("promotions.archive")}
                            confirmMessage={t("promotions.archiveConfirm")}
                          />
                        )}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {manage ? (
          <Card title={t("promotions.add")}>
            <PromotionForm
              action={createPromotionAction.bind(null, orgSlug)}
              categories={data.categories.map((c) => ({ value: c.id, label: named(c) }))}
              items={data.items.map((i) => ({ value: i.id, label: named(i) }))}
              channels={SALES_CHANNELS.map((c) => ({ value: c, label: t(`menu.channels.${c}`) }))}
              today={today}
            />
          </Card>
        ) : null}
        <Card title={t("promotions.coupons")}>
          {data.coupons.length === 0 ? (
            <p className="text-muted text-sm">{t("promotions.noCoupons")}</p>
          ) : (
            <Table label={t("promotions.coupons")}>
              <thead>
                <tr>
                  <Th>{t("promotions.code")}</Th>
                  <Th>{t("pos.discountValue")}</Th>
                  <Th>{t("promotions.when")}</Th>
                  <Th>{t("promotions.uses")}</Th>
                  <Th>{t("pos.status")}</Th>
                  {manage ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {data.coupons.map((c) => (
                  <tr key={c.id}>
                    <Td className="ltr-value font-mono">{c.code}</Td>
                    <Td className="ltr-value tabular-nums">
                      {c.kind === "PERCENT" ? `${c.value.toFixed()} %` : money.money(c.value)}
                    </Td>
                    <Td className="ltr-value text-sm">
                      {iso(c.validFrom)} → {c.validTo ? iso(c.validTo) : "…"}
                    </Td>
                    <Td className="ltr-value tabular-nums">
                      {c.uses}
                      {c.maxUses !== null ? ` / ${c.maxUses}` : ""}
                    </Td>
                    <Td>{status(c.archivedAt, c.validTo)}</Td>
                    {manage ? (
                      <Td>
                        {c.archivedAt ? null : (
                          <ConfirmActionButton
                            action={archiveCouponAction.bind(null, orgSlug, c.id)}
                            label={t("promotions.archive")}
                            confirmMessage={t("promotions.archiveCouponConfirm")}
                          />
                        )}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {manage ? (
          <Card title={t("promotions.addCoupon")}>
            <CouponForm action={createCouponAction.bind(null, orgSlug)} today={today} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
