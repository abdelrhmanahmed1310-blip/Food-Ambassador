import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AskForm } from "@/components/assistant/forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Card, EmptyState } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { askAction, deleteConversationAction } from "@/app/o/[orgSlug]/assistant/actions";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getConversation, listConversations } from "@/modules/assistant/service";
import type { TenantContext } from "@/modules/tenancy/context";

/**
 * A conversation screen shared by the business assistant (ADR-122) and the
 * food consultant (ADR-131): past conversations, the thread, and the
 * question box. Answers are shown as text, never as HTML.
 */
export async function ChatScreen({
  ctx,
  orgSlug,
  mode,
  chosenId,
  examples = [],
  intro,
}: {
  ctx: TenantContext;
  orgSlug: string;
  mode: "BUSINESS" | "CONSULTANT";
  chosenId: unknown;
  examples?: string[];
  intro?: string;
}) {
  const t = await getTranslations("assistant");
  const page = mode === "CONSULTANT" ? "consultant" : "assistant";
  const { enabled, conversations } = await listConversations(ctx, mode);
  const chosen = typeof chosenId === "string" && isUuid(chosenId) ? chosenId : null;
  const conversation =
    chosen && conversations.some((c) => c.id === chosen)
      ? await getConversation(ctx, chosen)
      : null;
  const base = `/o/${orgSlug}`;
  const answerLabel = mode === "CONSULTANT" ? t("consultantLabel") : t("assistantLabel");
  const hint = mode === "CONSULTANT" ? t("consultantQuestionHint") : undefined;

  if (!enabled)
    return (
      <EmptyState
        title={t("off")}
        hint={hasPermission(ctx.grants, "assistant.manage") ? t("offAdmin") : t("offAsk")}
      />
    );
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav aria-label={t("conversations")} className="space-y-2">
        <Link href={`${base}/${page}`} className={buttonClass("secondary", "w-full")}>
          {t("newConversation")}
        </Link>
        <ul className="space-y-1 text-sm">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`${base}/${page}?c=${c.id}`}
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
                      {m.role === "USER" ? t("you") : answerLabel}
                    </p>
                    {/* Shown as text: never rendered as HTML. */}
                    <p className="text-sm whitespace-pre-wrap" dir="auto">
                      {m.text}
                    </p>
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
                              {c.name} {JSON.stringify(c.input)} {c.ok ? "" : `(${t("notRead")})`}
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
              <AskForm action={askAction.bind(null, orgSlug, mode, conversation.id)} hint={hint} />
            </Card>
            <ConfirmActionButton
              action={deleteConversationAction.bind(null, orgSlug, mode, conversation.id)}
              label={t("delete")}
              confirmMessage={t("deleteConfirm")}
              variant="secondary"
            />
          </>
        ) : (
          <>
            {intro ? <p className="text-muted text-sm">{intro}</p> : null}
            {examples.length ? (
              <Card title={t("tryAsking")}>
                <ul className="list-disc space-y-1 ps-5 text-sm" data-testid="consultant-examples">
                  {examples.map((e) => (
                    <li key={e} dir="auto">
                      {e}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <Card>
              <AskForm action={askAction.bind(null, orgSlug, mode, null)} hint={hint} />
            </Card>
          </>
        )}
        <Alert tone="info">
          {mode === "CONSULTANT" ? t("consultantGovernance") : t("governance")}
        </Alert>
      </div>
    </div>
  );
}
