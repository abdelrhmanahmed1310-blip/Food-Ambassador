import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AskForm } from "@/components/assistant/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { canUseAssistant, getConversation, listConversations } from "@/modules/assistant/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { askAction, deleteConversationAction } from "./actions";

/** Questions in plain language, answered from the app's own reports (ADR-122). */
export default async function AssistantPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/assistant">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canUseAssistant(ctx)) notFound();
  const t = await getTranslations("assistant");
  const { enabled, conversations } = await listConversations(ctx);
  const chosen = typeof sp.c === "string" && isUuid(sp.c) ? sp.c : null;
  const conversation =
    chosen && conversations.some((c) => c.id === chosen)
      ? await getConversation(ctx, chosen)
      : null;
  const base = `/o/${orgSlug}`;

  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      {!enabled ? (
        <EmptyState
          title={t("off")}
          hint={hasPermission(ctx.grants, "assistant.manage") ? t("offAdmin") : t("offAsk")}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <nav aria-label={t("conversations")} className="space-y-2">
            <Link href={`${base}/assistant`} className={buttonClass("secondary", "w-full")}>
              {t("newConversation")}
            </Link>
            <ul className="space-y-1 text-sm">
              {conversations.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`${base}/assistant?c=${c.id}`}
                    aria-current={c.id === conversation?.id ? "page" : undefined}
                    className={`block truncate rounded-md px-2 py-1 ${c.id === conversation?.id ? "bg-surface-muted font-medium" : "hover:bg-surface-muted"}`}
                  >
                    {c.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="space-y-4">
            {conversation ? (
              <>
                <ol className="space-y-3" aria-label={conversation.title}>
                  {conversation.messages.map((m) => (
                    <li key={m.id} data-testid={`assistant-${m.role.toLowerCase()}`}>
                      <Card>
                        <p className="text-muted mb-1 text-xs font-medium">
                          {m.role === "USER" ? t("you") : t("assistantLabel")}
                        </p>
                        {/* Shown as text: never rendered as HTML. */}
                        <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                        {m.sources.length > 0 ? (
                          <div className="mt-3 text-xs">
                            <span className="text-muted">{t("sources")} </span>
                            {m.sources.map((s, i) => (
                              <span key={s.href}>
                                {i > 0 ? " · " : null}
                                <Link
                                  href={`${base}${s.href}`}
                                  className="text-primary hover:underline"
                                >
                                  {s.label}
                                </Link>
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {m.toolCalls.length > 0 ? (
                          <details className="text-muted mt-2 text-xs">
                            <summary>{t("readCount", { count: m.toolCalls.length })}</summary>
                            <ul className="mt-1 list-disc ps-5" dir="ltr">
                              {m.toolCalls.map((c, i) => (
                                <li key={i}>
                                  {c.name} {JSON.stringify(c.input)}{" "}
                                  {c.ok ? "" : `(${t("notRead")})`}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </Card>
                    </li>
                  ))}
                </ol>
                <Card>
                  <AskForm action={askAction.bind(null, orgSlug, conversation.id)} />
                </Card>
                <ConfirmActionButton
                  action={deleteConversationAction.bind(null, orgSlug, conversation.id)}
                  label={t("delete")}
                  confirmMessage={t("deleteConfirm")}
                  variant="secondary"
                />
              </>
            ) : (
              <Card>
                <AskForm action={askAction.bind(null, orgSlug, null)} />
              </Card>
            )}
            <Alert tone="info">{t("governance")}</Alert>
          </div>
        </div>
      )}
    </>
  );
}
