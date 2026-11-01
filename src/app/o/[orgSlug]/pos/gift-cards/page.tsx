import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listGiftCards } from "@/modules/pos/gift-cards";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { blockGiftCardAction } from "../customers/actions";

/** Gift cards sold and what is still owed on them (ADR-068). */
export default async function GiftCardsPage({ params }: PageProps<"/o/[orgSlug]/pos/gift-cards">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "payments.manage")) notFound();
  const [t, format, money, data] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listGiftCards(ctx),
  ]);
  const m = (v: { toString(): string }) => (
    <span className="ltr-value tabular-nums">{money.money(v)}</span>
  );
  return (
    <>
      <PageHeader title={t("giftCards.title")} description={t("giftCards.intro")} />
      <div className="space-y-6">
        <Card title={t("giftCards.summary")}>
          <DescriptionList
            items={[
              { label: t("giftCards.count"), value: data.cards.length },
              {
                label: t("giftCards.owed"),
                value: <strong data-testid="gift-owed">{m(data.owed)}</strong>,
              },
            ]}
          />
        </Card>
        <Card title={t("giftCards.list")}>
          {data.cards.length === 0 ? (
            <p className="text-muted text-sm">{t("giftCards.none")}</p>
          ) : (
            <Table label={t("giftCards.list")}>
              <thead>
                <tr>
                  <Th>{t("giftCards.card")}</Th>
                  <Th>{t("giftCards.value")}</Th>
                  <Th>{t("giftCards.balance")}</Th>
                  <Th>{t("giftCards.sold")}</Th>
                  <Th>{t("pos.status")}</Th>
                  <Th>{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.cards.map((g) => (
                  <tr key={g.id}>
                    <Td className="ltr-value font-mono">•••• {g.last4}</Td>
                    <Td>{m(g.initialValue)}</Td>
                    <Td>{m(g.balance)}</Td>
                    <Td>
                      {format.dateTime(g.createdAt, {
                        dateStyle: "medium",
                        timeZone: ctx.timeZone,
                      })}{" "}
                      · {t(`pos.methods.${g.soldMethod}`)}
                    </Td>
                    <Td>
                      {g.blockedAt ? (
                        <Badge tone="danger">{t("giftCards.blocked")}</Badge>
                      ) : (
                        <Badge tone="success">{t("giftCards.active")}</Badge>
                      )}
                    </Td>
                    <Td>
                      {g.blockedAt ? null : (
                        <ConfirmActionButton
                          action={blockGiftCardAction.bind(null, orgSlug, g.id)}
                          label={t("giftCards.block")}
                          confirmMessage={t("giftCards.blockConfirm")}
                        />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
