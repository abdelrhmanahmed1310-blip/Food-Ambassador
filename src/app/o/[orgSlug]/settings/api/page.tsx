import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CreateApiKeyForm } from "@/components/api/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listApiClients } from "@/modules/api/clients";
import { API_SCOPE_NAMES } from "@/modules/api/scopes";
import { listConnectedApps } from "@/modules/oauth/service";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createApiKeyAction, revokeApiKeyAction, revokeConnectedAppAction } from "./actions";

/** Keys for the REST API v1 (ADR-090). */
export default async function ApiKeysPage({ params }: PageProps<"/o/[orgSlug]/settings/api">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "integrations.manage")) notFound();
  const [t, format, clients, companies, apps] = await Promise.all([
    getTranslations("api"),
    getFormatter(),
    listApiClients(ctx),
    listCompanies(ctx),
    listConnectedApps(ctx),
  ]);
  const when = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">
          {t("docs")}{" "}
          <a href="/api/v1/openapi.json" className="ltr-value text-primary underline">
            /api/v1/openapi.json
          </a>{" "}
          ·{" "}
          <Link href={`/o/${orgSlug}/settings/api/reference`} className="text-primary underline">
            {t("reference")}
          </Link>
        </Alert>
        <Card title={t("mcpTitle")}>
          <div className="space-y-2 text-sm" data-testid="mcp-connect">
            <p>{t("mcpIntro")}</p>
            <p>
              {t("mcpEndpoint")}{" "}
              <code className="ltr-value bg-surface-muted rounded px-1">/api/mcp</code>
            </p>
            <pre className="ltr-value bg-surface-muted overflow-x-auto rounded p-3 text-xs">
              {`Authorization: Bearer fa_…`}
            </pre>
            <p className="text-muted">{t("mcpAccess")}</p>
            <p className="text-muted">{t("mcpOAuth")}</p>
          </div>
        </Card>
        <Card title={t("connectedApps")}>
          {apps.length === 0 ? (
            <p className="text-muted text-sm">{t("noConnectedApps")}</p>
          ) : (
            <Table label={t("connectedApps")}>
              <thead>
                <tr>
                  <Th>{t("app")}</Th>
                  <Th>{t("connectedBy")}</Th>
                  <Th>{t("scopes")}</Th>
                  <Th>{t("connectedOn")}</Th>
                  <Th>{t("lastUsed")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.id} data-testid="connected-app-row">
                    <Td>{a.client.clientName}</Td>
                    <Td>{a.userName}</Td>
                    <Td className="ltr-value text-xs">{a.scopes.join(", ")}</Td>
                    <Td className="ltr-value">{when(a.createdAt)}</Td>
                    <Td className="ltr-value">{when(a.lastUsedAt)}</Td>
                    <Td>
                      <ConfirmActionButton
                        action={revokeConnectedAppAction.bind(null, orgSlug, a.id)}
                        label={t("disconnect")}
                        confirmMessage={t("disconnectConfirm")}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {clients.length === 0 ? (
          <EmptyState title={t("none")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("name")}</Th>
                <Th>{t("keyStart")}</Th>
                <Th>{t("scopes")}</Th>
                <Th>{t("company")}</Th>
                <Th>{t("lastUsed")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} data-testid="api-key-row">
                  <Td>{c.name}</Td>
                  <Td className="ltr-value font-mono text-xs">fa_{c.keyPrefix}_…</Td>
                  <Td className="ltr-value text-xs">{c.scopes.join(", ")}</Td>
                  <Td>{c.company ? `${c.company.code} — ${c.company.name}` : t("allCompanies")}</Td>
                  <Td className="ltr-value">{when(c.lastUsedAt)}</Td>
                  <Td>
                    {c.revokedAt ? (
                      <Badge tone="muted">{t("revoked")}</Badge>
                    ) : (
                      <ConfirmActionButton
                        action={revokeApiKeyAction.bind(null, orgSlug, c.id)}
                        label={t("revoke")}
                        confirmMessage={t("revokeConfirm")}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Card title={t("create")}>
          <CreateApiKeyForm
            action={createApiKeyAction.bind(null, orgSlug)}
            scopes={API_SCOPE_NAMES.map((s) => ({
              value: s,
              label: t(`scopeNames.${s.replace(":", "_")}`),
              hint: s,
            }))}
            companies={companies.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
          />
        </Card>
      </div>
    </>
  );
}
