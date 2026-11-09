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
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

/** Keys for the REST API v1 (ADR-090). */
export default async function ApiKeysPage({ params }: PageProps<"/o/[orgSlug]/settings/api">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "integrations.manage")) notFound();
  const [t, format, clients, companies] = await Promise.all([
    getTranslations("api"),
    getFormatter(),
    listApiClients(ctx),
    listCompanies(ctx),
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
