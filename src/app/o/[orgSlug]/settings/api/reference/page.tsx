import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { openApiDocument } from "@/modules/api/openapi";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getEnv } from "@/server/env";

interface Param {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: unknown; enum?: readonly string[] };
}
interface Operation {
  summary: string;
  security: Array<{ apiKey: readonly string[] }>;
  parameters?: readonly Param[];
  requestBody?: unknown;
  responses: Record<string, { description: string }>;
}

const typeOf = (s: Param["schema"]) =>
  s?.enum
    ? s.enum.join(" | ")
    : Array.isArray(s?.type)
      ? s.type.join(" | ")
      : String(s?.type ?? "");

/**
 * The REST API v1 reference, rendered from the same OpenAPI document as
 * /api/v1/openapi.json (ADR-090, ADR-132). Shown in the app instead of a
 * hosted Swagger UI, whose third-party scripts the CSP does not allow.
 */
export default async function ApiReferencePage({
  params,
}: PageProps<"/o/[orgSlug]/settings/api/reference">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "integrations.manage")) notFound();
  const t = await getTranslations("api");
  const doc = openApiDocument(getEnv().APP_URL);
  const groups = new Map<string, Array<{ path: string; method: string; op: Operation }>>();
  for (const [path, item] of Object.entries(
    doc.paths as Record<string, Record<string, Operation>>,
  )) {
    const group = path.split("/")[1];
    for (const [method, op] of Object.entries(item))
      groups.set(group, [...(groups.get(group) ?? []), { path, method: method.toUpperCase(), op }]);
  }
  return (
    <>
      <PageHeader title={t("reference")} description={t("referenceIntro")} />
      <p className="mb-4 text-sm">
        <Link href={`/o/${orgSlug}/settings/api`} className="text-primary underline">
          {t("back")}
        </Link>{" "}
        ·{" "}
        <a href="/api/v1/openapi.json" className="ltr-value text-primary underline">
          openapi.json
        </a>
      </p>
      <div className="space-y-6">
        {[...groups].map(([group, ops]) => (
          <Card key={group} title={`/${group}`}>
            <ul className="divide-border divide-y" dir="ltr">
              {ops.map(({ path, method, op }) => (
                <li key={`${method} ${path}`} className="py-3" data-testid="api-endpoint">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={method === "GET" ? "success" : "warning"}>{method}</Badge>
                    <code className="font-mono text-sm">/api/v1{path}</code>
                    {op.security
                      .flatMap((s) => s.apiKey)
                      .map((scope) => (
                        <Badge key={scope} tone="muted">
                          {scope}
                        </Badge>
                      ))}
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">{op.summary}</p>
                  {op.parameters?.length ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer">{t("parameters")}</summary>
                      <ul className="mt-1 space-y-0.5 ps-4">
                        {op.parameters.map((p) => (
                          <li key={`${p.in}:${p.name}`}>
                            <code>{p.name}</code> ({p.in}, {typeOf(p.schema)}
                            {p.required ? `, ${t("required")}` : ""})
                            {p.description ? ` — ${p.description}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {op.requestBody ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer">{t("body")}</summary>
                      <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded p-2">
                        {JSON.stringify(
                          (op.requestBody as { content: Record<string, { schema: unknown }> })
                            .content["application/json"].schema,
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : null}
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t("responses")}: {Object.keys(op.responses).join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
