import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CopyField } from "@/components/forms/fields";
import { OrderingChannelForm } from "@/components/pos/ordering-forms";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { paymentProvider } from "@/modules/payments/links";
import { listOrderingChannels } from "@/modules/pos/ordering";
import { listRegisters } from "@/modules/pos/service";
import { listBranches } from "@/modules/sites/branches";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getEnv } from "@/server/env";
import { archiveChannelAction, createChannelAction } from "../actions";

/** Online ordering pages and kiosks of the branches (ADR-070). */
export default async function OnlineSetupPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/online/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "pos.manage")) notFound();
  const [t, channels, branches, registers, provider] = await Promise.all([
    getTranslations(),
    listOrderingChannels(ctx),
    listBranches(ctx),
    listRegisters(ctx),
    paymentProvider(ctx),
  ]);
  const base = getEnv().APP_URL;
  return (
    <>
      <PageHeader title={t("ordering.setupTitle")} description={t("ordering.setupIntro")} />
      <div className="space-y-6">
        <Card title={t("ordering.channelsTitle")}>
          {channels.length === 0 ? (
            <p className="text-muted text-sm">{t("ordering.noChannels")}</p>
          ) : (
            <ul className="space-y-4">
              {channels.map((c) => (
                <li
                  key={c.id}
                  className="border-border space-y-2 rounded-md border p-3"
                  data-testid="ordering-channel"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {c.name} · {t(`ordering.kinds.${c.kind}`)} · {c.branch.name}
                    </p>
                    {c.archivedAt ? (
                      <Badge tone="muted">{t("ordering.archived")}</Badge>
                    ) : (
                      <ConfirmActionButton
                        action={archiveChannelAction.bind(null, orgSlug, c.id)}
                        label={t("ordering.archive")}
                        confirmMessage={t("ordering.archiveConfirm")}
                      />
                    )}
                  </div>
                  {c.archivedAt ? null : (
                    <CopyField
                      value={`${base}/${c.kind === "WEB" ? "order" : "kiosk"}/${c.publicToken}`}
                      label={t("ordering.address")}
                      copyLabel={t("integrations.copy")}
                      copiedLabel={t("integrations.copied")}
                    />
                  )}
                  <p className="text-muted text-sm">
                    {c.channels.map((ch) => t(`ordering.channels.${ch}`)).join(" · ")}
                    {c.autoSend ? ` · ${t("ordering.autoSendShort")}` : ""}
                    {` · ${t(`ordering.paymentModes.${c.paymentMode}`)}`}
                    {c.scheduling
                      ? ` · ${t("ordering.pickupWindow", { from: c.openFrom ?? "", to: c.openTo ?? "" })}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("ordering.addChannel")}>
          <OrderingChannelForm
            action={createChannelAction.bind(null, orgSlug)}
            branches={branches.items.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            registers={registers.map((r) => ({
              value: r.id,
              label: `${r.code} — ${r.name} (${r.branch.name})`,
            }))}
            onlinePayments={provider !== null}
          />
        </Card>
      </div>
    </>
  );
}
