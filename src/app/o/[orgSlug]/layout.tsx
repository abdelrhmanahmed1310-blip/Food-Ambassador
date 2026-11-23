import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Bell, ChevronDown, LogOut, Search, ShieldCheck, Store } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { groupNav } from "@/components/shell/nav-groups";
import { DesktopNav, MobileNav } from "@/components/shell/nav-links";
import { ProcessTabs } from "@/components/shell/process-tabs";
import { unreadCount } from "@/modules/notifications/service";
import { listUserOrganizations } from "@/modules/organizations/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getCurrentUser } from "@/server/auth/session";
import { navLinks } from "@/server/navigation";
import { signOutAction } from "../../(auth)/actions";

/**
 * Tenant shell. requireTenant() resolves membership server-side and 404s for
 * non-members; navigation only hides links the user cannot use — every page
 * and action re-checks permissions itself.
 */
export default async function TenantLayout({ children, params }: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, tn, ts, user, orgs, unread] = await Promise.all([
    getTranslations("nav"),
    getTranslations("notifications"),
    getTranslations("search"),
    getCurrentUser(),
    listUserOrganizations(ctx.userId),
    unreadCount(ctx),
  ]);
  const base = `/o/${ctx.organizationSlug}`;

  const links = await navLinks(ctx);
  const { sections, tabs } = groupNav(links, base, (key) => t(`groups.${key}` as "groups.sell"));

  return (
    <div className="flex min-h-full flex-1">
      <DesktopNav sections={sections} label={t("main")} homeHref={base} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-surface/95 sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur sm:px-6 print:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <MobileNav
              sections={sections}
              label={t("main")}
              openLabel={t("openMenu")}
              closeLabel={t("closeMenu")}
            />
            <Link href={base} className="shrink-0 lg:hidden">
              <Logo className="h-12 w-auto" />
            </Link>
            <details className="relative min-w-0">
              <summary className="hover:bg-surface-muted flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 font-semibold">
                <Store aria-hidden="true" className="text-primary size-4 shrink-0" />
                <span className="truncate">{ctx.organizationName}</span>
                <span className="sr-only">{t("switchOrganization")}</span>
                <ChevronDown aria-hidden="true" className="text-muted size-4 shrink-0" />
              </summary>
              <div className="border-border bg-surface absolute start-0 z-30 mt-1 w-64 rounded-lg border p-1 shadow-lg">
                <ul>
                  {orgs.map((org) => (
                    <li key={org.id}>
                      <Link
                        href={`/o/${org.slug}`}
                        aria-current={org.id === ctx.organizationId ? "true" : undefined}
                        className={`hover:bg-surface-muted block truncate rounded px-3 py-2 text-sm ${org.id === ctx.organizationId ? "text-primary font-medium" : ""}`}
                      >
                        {org.name}
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/organizations/new"
                  className="border-border text-primary hover:bg-surface-muted mt-1 block border-t px-3 py-2 text-sm"
                >
                  {t("newOrganization")}
                </Link>
              </div>
            </details>
          </div>
          <div className="flex items-center gap-1">
            <form method="get" action={`${base}/search`} role="search" className="hidden md:block">
              <label htmlFor="global-search" className="sr-only">
                {ts("label")}
              </label>
              <input
                id="global-search"
                name="q"
                type="search"
                minLength={2}
                maxLength={80}
                placeholder={ts("placeholder")}
                className="border-border bg-surface w-56 rounded-md border px-3 py-1.5 text-sm"
              />
            </form>
            <Link
              href={`${base}/search`}
              className="hover:bg-surface-muted rounded-md p-2 md:hidden"
              aria-label={ts("title")}
            >
              <Search aria-hidden="true" className="size-5" />
            </Link>
            <Link
              href={`${base}/notifications`}
              className="hover:bg-surface-muted relative rounded-md p-2"
              aria-label={tn("bell", { count: unread })}
              data-testid="notification-bell"
            >
              <Bell aria-hidden="true" className="size-5" />
              {unread > 0 ? (
                <span className="bg-primary absolute -end-0.5 -top-0.5 min-w-5 rounded-full px-1 text-center text-[11px] leading-5 font-semibold text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
            </Link>
            <LocaleSwitcher />
            <span
              className="text-muted hidden max-w-40 items-center gap-2 truncate px-2 text-sm sm:flex"
              title={user?.email}
            >
              <span
                aria-hidden="true"
                className="bg-foreground text-surface flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              >
                {(user?.name ?? "?").trim().charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{user?.name}</span>
            </span>
            <Link
              href="/account/security"
              className="hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              <span className="sr-only sm:not-sr-only">{t("security")}</span>
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
              >
                <LogOut aria-hidden="true" className="size-4" />
                <span className="sr-only sm:not-sr-only">{t("signOut")}</span>
              </button>
            </form>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <ProcessTabs groups={tabs} hubLabel={t("allSettings")} />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
