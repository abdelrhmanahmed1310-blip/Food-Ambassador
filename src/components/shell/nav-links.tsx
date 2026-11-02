"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  Bell,
  Boxes,
  Building2,
  ChefHat,
  ChevronDown,
  Clock,
  Handshake,
  LayoutDashboard,
  Menu,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Truck,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";

/** Icon names the server layout may use (components cannot cross the server/client boundary). */
const ICONS = {
  overview: LayoutDashboard,
  attention: Bell,
  branches: Building2,
  warehouses: Warehouse,
  pos: ShoppingCart,
  inventory: Boxes,
  purchasing: Truck,
  kitchen: ChefHat,
  b2b: Handshake,
  safety: ShieldCheck,
  reports: BarChart3,
  catalog: Package,
  settings: Settings,
  store: Store,
  hr: Users,
  clock: Clock,
} satisfies Record<string, LucideIcon>;
export type NavIcon = keyof typeof ICONS;

export interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
  icon?: NavIcon;
}
export interface NavSection {
  title?: string;
  icon?: NavIcon;
  items: NavItem[];
}

function matches(pathname: string, item: NavItem) {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The one item for this page: the longest matching address (…/pos/floor, not …/pos). */
function activeHref(pathname: string, sections: NavSection[]) {
  let best: string | null = null;
  for (const section of sections)
    for (const item of section.items)
      if (matches(pathname, item) && (best === null || item.href.length > best.length))
        best = item.href;
  return best;
}

function ItemLink({
  item,
  active,
  onNavigate,
  nested,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  nested?: boolean;
}) {
  const Icon = item.icon ? ICONS[item.icon] : null;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-3 rounded-md py-2 text-sm transition-colors ${nested ? "ps-10 pe-3" : "px-3"} ${
        active
          ? "bg-sidebar-hover before:bg-primary font-medium text-white before:absolute before:inset-y-1.5 before:start-0 before:w-1 before:rounded-full"
          : "text-sidebar-muted hover:bg-sidebar-hover hover:text-white"
      }`}
    >
      {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function Links({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const active = activeHref(usePathname(), sections);
  return (
    <div className="space-y-1">
      {sections.map((section, i) => {
        const items = (
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.href}>
                <ItemLink
                  item={item}
                  active={item.href === active}
                  onNavigate={onNavigate}
                  nested={Boolean(section.title)}
                />
              </li>
            ))}
          </ul>
        );
        if (!section.title) return <div key={i}>{items}</div>;
        const Icon = section.icon ? ICONS[section.icon] : null;
        const holdsActive = section.items.some((item) => item.href === active);
        return (
          // Closed groups keep their links in the page (hidden), so nothing is lost; the
          // group holding the current page opens by itself.
          <details key={section.title} open={holdsActive || undefined} className="group">
            <summary
              className={`flex cursor-pointer list-none items-center gap-3 rounded-md px-3 py-2 text-sm font-medium select-none ${
                holdsActive ? "text-white" : "text-sidebar-foreground/90 hover:bg-sidebar-hover"
              }`}
            >
              {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
              <span className="flex-1 truncate">{section.title}</span>
              <ChevronDown
                aria-hidden="true"
                className="text-sidebar-muted size-4 shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="mt-0.5 mb-1">{items}</div>
          </details>
        );
      })}
    </div>
  );
}

function BrandTile({ href }: { href: string }) {
  return (
    <Link href={href} className="mb-4 block rounded-lg bg-white px-3 py-2">
      <Logo className="mx-auto h-10 w-auto" />
    </Link>
  );
}

export function DesktopNav({
  sections,
  label,
  homeHref,
}: {
  sections: NavSection[];
  label: string;
  homeHref: string;
}) {
  // The black column runs the full page height; the menu inside stays in view.
  return (
    <div className="bg-sidebar hidden w-64 shrink-0 lg:block print:hidden">
      <nav aria-label={label} className="sticky top-0 h-dvh overflow-y-auto px-3 py-4">
        <BrandTile href={homeHref} />
        <Links sections={sections} />
      </nav>
    </div>
  );
}

/** Toggleable panel for small screens. */
export function MobileNav({
  sections,
  label,
  openLabel,
  closeLabel,
}: {
  sections: NavSection[];
  label: string;
  openLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lg:hidden">
      <button
        type="button"
        className="border-border hover:bg-surface-muted rounded-md border p-1.5"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <X aria-hidden="true" className="size-5" />
        ) : (
          <Menu aria-hidden="true" className="size-5" />
        )}
      </button>
      {open ? (
        <nav
          id="mobile-nav"
          aria-label={label}
          className="bg-sidebar absolute inset-x-0 top-14 z-20 max-h-[calc(100dvh-3.5rem)] overflow-y-auto px-3 py-4 shadow-lg"
        >
          <Links sections={sections} onNavigate={() => setOpen(false)} />
        </nav>
      ) : null}
    </div>
  );
}
