import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { MarkAllReadForm, NotificationPreferencesForm } from "@/components/notifications/forms";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import {
  listNotifications,
  notificationPreferences,
  type NotificationKind,
} from "@/modules/notifications/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { markAllReadAction, savePreferencesAction } from "./actions";

/** The user's notifications and what they want to be told (ADR-087). */
export default async function NotificationsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/notifications">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const unreadOnly = sp.unread === "1";
  const page = Math.max(1, Number(sp.page) || 1);
  const [t, format, list, prefs] = await Promise.all([
    getTranslations("notifications"),
    getFormatter(),
    listNotifications(ctx, { unreadOnly, page }),
    notificationPreferences(ctx),
  ]);
  const base = `/o/${orgSlug}/notifications`;
  const message = (kind: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, string | number>;
    const key = `kinds.${kind}` as `kinds.${NotificationKind}`;
    if (!t.has(key)) return kind;
    // Outcomes are codes; show them in words.
    const outcome =
      typeof p.outcome === "string" && t.has(`outcomes.${p.outcome}` as "outcomes.POSTED")
        ? t(`outcomes.${p.outcome}` as "outcomes.POSTED")
        : p.outcome;
    // Job kinds have dots ("attention.digest"); message keys use underscores.
    const jobKey = typeof p.kind === "string" ? `jobKinds.${p.kind.replace(/\./g, "_")}` : "";
    const jobKind =
      jobKey && t.has(jobKey as "jobKinds.attention_digest")
        ? t(jobKey as "jobKinds.attention_digest")
        : p.kind;
    return t(key, { ...p, outcome: outcome ?? "", kind: jobKind ?? "" });
  };
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex gap-2 text-sm" aria-label={t("title")}>
            <Link
              href={base}
              aria-current={!unreadOnly ? "page" : undefined}
              className={`rounded-md border px-3 py-1 ${!unreadOnly ? "border-primary text-primary font-medium" : "border-border"}`}
            >
              {t("all")}
            </Link>
            <Link
              href={`${base}?unread=1`}
              aria-current={unreadOnly ? "page" : undefined}
              className={`rounded-md border px-3 py-1 ${unreadOnly ? "border-primary text-primary font-medium" : "border-border"}`}
            >
              {t("unreadOnly", { count: list.unread })}
            </Link>
          </nav>
          {list.unread > 0 ? (
            <MarkAllReadForm action={markAllReadAction.bind(null, orgSlug)} />
          ) : null}
        </div>
        {list.items.length === 0 ? (
          <EmptyState title={t("none")} />
        ) : (
          <Card>
            <ul className="divide-border divide-y" data-testid="notification-list">
              {list.items.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <a
                    href={`${base}/${n.id}`}
                    className={`hover:underline ${n.readAt ? "text-muted" : "font-medium"}`}
                    data-testid="notification"
                  >
                    {n.readAt ? null : (
                      <Badge tone="neutral">
                        <span className="sr-only">{t("unread")}</span>•
                      </Badge>
                    )}{" "}
                    {message(n.kind, n.params)}
                  </a>
                  <span className="text-muted text-xs">
                    {format.dateTime(n.createdAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                  </span>
                </li>
              ))}
            </ul>
            {list.pageCount > 1 ? (
              <nav className="mt-4 flex gap-2 text-sm">
                {page > 1 ? (
                  <Link href={`${base}?page=${page - 1}${unreadOnly ? "&unread=1" : ""}`}>
                    {t("previous")}
                  </Link>
                ) : null}
                {page < list.pageCount ? (
                  <Link href={`${base}?page=${page + 1}${unreadOnly ? "&unread=1" : ""}`}>
                    {t("next")}
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </Card>
        )}
        <Card title={t("preferences")}>
          <Alert tone="info">{t("channelsNote")}</Alert>
          <div className="mt-4">
            <NotificationPreferencesForm
              action={savePreferencesAction.bind(null, orgSlug)}
              kinds={prefs.map((p) => ({ ...p, label: t(`kindNames.${p.kind}`) }))}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
