import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SETTINGS_CARDS } from "@/components/shell/nav-groups";
import { Card, PageHeader } from "@/components/ui/primitives";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { navLinks } from "@/server/navigation";

/** Settings in one place (ADR-139): what this person may change, grouped by subject. */
export default async function SettingsPage({ params }: PageProps<"/o/[orgSlug]/settings">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, links] = await Promise.all([getTranslations("nav"), navLinks(ctx)]);
  const base = `/o/${ctx.organizationSlug}`;
  const byPath = new Map(links.map((l) => [l.href.slice(base.length + 1), l]));
  const cards = SETTINGS_CARDS.map((c) => ({
    key: c.key,
    links: c.paths.flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : [])),
  })).filter((c) => c.links.length > 0);
  if (cards.length === 0) notFound();
  return (
    <>
      <PageHeader title={t("settings")} description={t("settingsIntro")} />
      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((c) => (
          <Card key={c.key} title={t(`settingsCards.${c.key}` as "settingsCards.organization")}>
            <ul className="divide-border divide-y" data-testid={`settings-${c.key}`}>
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-primary block py-2 text-sm font-medium hover:underline"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
