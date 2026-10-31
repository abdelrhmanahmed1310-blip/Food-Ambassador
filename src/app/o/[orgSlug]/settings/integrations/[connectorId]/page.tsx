import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { RotateSecretForm } from "@/components/integrations/forms";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getConnector } from "@/modules/integrations/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getEnv } from "@/server/env";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { retryDeliveryAction, rotateSecretAction, setConnectorStatusAction } from "../actions";

const tones = {
  ACCEPTED: "success",
  DELIVERED: "success",
  DUPLICATE: "muted",
  PENDING: "warning",
  REJECTED: "danger",
  FAILED: "danger",
} as const;

export default async function ConnectorPage({
  params,
}: PageProps<"/o/[orgSlug]/settings/integrations/[connectorId]">) {
  const { orgSlug, connectorId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "integrations.manage")) notFound();
  if (!isUuid(connectorId)) notFound();
  const c = await notFoundOnAppError(getConnector(ctx, connectorId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const when = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const config = c.config as { warehouseId?: string; url?: string; events?: string[] };
  const inbound = c.kind === "INBOUND_SALES_WEBHOOK";
  const next = c.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  return (
    <>
      <PageHeader
        title={c.name}
        description={t(`integrations.kinds.${c.kind}`)}
        actions={
          <>
            <LinkButton href={`/o/${orgSlug}/settings/integrations`} variant="secondary">
              {t("integrations.back")}
            </LinkButton>
            <ConfirmActionButton
              action={setConnectorStatusAction.bind(null, orgSlug, c.id, next)}
              label={t(next === "DISABLED" ? "integrations.disable" : "integrations.enable")}
              variant={next === "DISABLED" ? "danger" : "primary"}
              confirmMessage={next === "DISABLED" ? t("integrations.disableConfirm") : undefined}
            />
          </>
        }
      />
      <Card>
        <DescriptionList
          items={[
            {
              label: t("integrations.status"),
              value: (
                <Badge tone={c.status === "ACTIVE" ? "success" : "muted"}>
                  {t(`integrations.statuses.${c.status}`)}
                </Badge>
              ),
            },
            inbound
              ? {
                  label: t("integrations.endpoint"),
                  value: (
                    <span className="ltr-value font-mono text-xs break-all">
                      {`${getEnv().APP_URL}/api/integrations/inbound/${c.publicId}`}
                    </span>
                  ),
                }
              : {
                  label: t("integrations.url"),
                  value: (
                    <span className="ltr-value font-mono text-xs break-all">{config.url}</span>
                  ),
                },
            ...(inbound
              ? []
              : [
                  {
                    label: t("integrations.events"),
                    value: (
                      <span className="ltr-value font-mono text-xs">
                        {(config.events ?? []).join(", ")}
                      </span>
                    ),
                  },
                ]),
            {
              label: t("integrations.secret"),
              value: <span className="ltr-value font-mono text-xs">{c.secretHint}</span>,
            },
            { label: t("integrations.created"), value: when(c.createdAt) },
            { label: t("integrations.rotated"), value: when(c.secretRotatedAt) },
          ]}
        />
        <div className="mt-4">
          <RotateSecretForm action={rotateSecretAction.bind(null, orgSlug, c.id)} />
        </div>
      </Card>
      <div className="mt-6">
        {inbound ? (
          <Card title={t("integrations.inboundEvents")}>
            {c.events.length === 0 ? (
              <EmptyState title={t("integrations.noEvents")} />
            ) : (
              <Table label={t("integrations.inboundEvents")}>
                <thead>
                  <tr>
                    <Th>{t("integrations.received")}</Th>
                    <Th>{t("integrations.idempotencyKey")}</Th>
                    <Th>{t("integrations.status")}</Th>
                    <Th>{t("integrations.outcome")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {c.events.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{when(e.receivedAt)}</Td>
                      <Td>
                        <span className="ltr-value font-mono text-xs">
                          {e.idempotencyKey ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={tones[e.status]}>
                          {t(`integrations.eventStatuses.${e.status}`)}
                        </Badge>
                      </Td>
                      <Td>
                        <span className="ltr-value font-mono text-xs break-all">
                          {JSON.stringify(e.outcome)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : (
          <Card title={t("integrations.deliveries")}>
            {c.deliveries.length === 0 ? (
              <EmptyState title={t("integrations.noDeliveries")} />
            ) : (
              <Table label={t("integrations.deliveries")}>
                <thead>
                  <tr>
                    <Th>{t("integrations.event")}</Th>
                    <Th>{t("integrations.status")}</Th>
                    <Th>{t("integrations.attempts")}</Th>
                    <Th>{t("integrations.lastResult")}</Th>
                    <Th>{t("integrations.nextAttempt")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {c.deliveries.map((d) => (
                    <tr key={d.id}>
                      <Td>
                        <span className="ltr-value font-mono text-xs break-all">{d.eventKey}</span>
                      </Td>
                      <Td>
                        <Badge tone={tones[d.status]}>
                          {t(`integrations.deliveryStatuses.${d.status}`)}
                        </Badge>
                      </Td>
                      <Td className="tabular-nums">{d.attempts}</Td>
                      <Td>
                        <span className="ltr-value font-mono text-xs">
                          {d.lastStatusCode ?? ""} {d.lastError ?? (d.deliveredAt ? "ok" : "—")}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {d.status === "PENDING" ? when(d.nextAttemptAt) : "—"}
                      </Td>
                      <Td>
                        {d.status === "FAILED" ? (
                          <ConfirmActionButton
                            action={retryDeliveryAction.bind(null, orgSlug, d.id)}
                            label={t("integrations.retry")}
                            variant="secondary"
                          />
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
