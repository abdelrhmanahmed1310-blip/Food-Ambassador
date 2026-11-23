"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeTab, type TabGroup } from "./nav-groups";

/**
 * The related pages of the current process as tabs (ADR-139): e.g. on a
 * purchase order, Requisitions · Requests for quotation · Purchase orders ·
 * Reorder · Demand forecast. Settings pages link back to the Settings hub.
 */
export function ProcessTabs({ groups, hubLabel }: { groups: TabGroup[]; hubLabel: string }) {
  const pathname = usePathname();
  const found = activeTab(pathname, groups);
  if (!found || found.group.ownTabs) return null;
  const { group, link } = found;
  if (group.hub) {
    if (!link) return null;
    return (
      <nav aria-label={group.label} className="mb-4 print:hidden">
        <Link href={group.hub} className="text-primary text-sm hover:underline">
          ← {hubLabel}
        </Link>
      </nav>
    );
  }
  if (group.links.length < 2) return null;
  return (
    <nav
      aria-label={group.label}
      className="mb-5 overflow-x-auto print:hidden"
      data-testid="process-tabs"
    >
      <ul className="border-border flex min-w-max gap-1 border-b">
        {group.links.map((l) => {
          const active = l.href === link?.href;
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                  active
                    ? "border-primary text-primary font-medium"
                    : "text-muted hover:text-foreground border-transparent"
                }`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
