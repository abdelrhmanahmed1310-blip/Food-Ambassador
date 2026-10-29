"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}
export interface NavSection {
  title?: string;
  items: NavItem[];
}

function Links({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      {sections.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title ? (
            <p className="text-muted mb-1 px-3 text-xs font-semibold">{section.title}</p>
          ) : null}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-3 py-2 text-sm ${active ? "bg-surface-muted text-foreground font-medium" : "text-muted hover:bg-surface-muted hover:text-foreground"}`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DesktopNav({ sections, label }: { sections: NavSection[]; label: string }) {
  return (
    <nav
      aria-label={label}
      className="border-border bg-surface hidden w-60 shrink-0 border-e px-3 py-6 lg:block"
    >
      <Links sections={sections} />
    </nav>
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
        className="border-border rounded-md border px-2.5 py-1 text-lg leading-none"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? "✕" : "☰"}</span>
      </button>
      {open ? (
        <nav
          id="mobile-nav"
          aria-label={label}
          className="border-border bg-surface absolute inset-x-0 top-14 z-20 border-b px-4 py-4 shadow-sm"
        >
          <Links sections={sections} onNavigate={() => setOpen(false)} />
        </nav>
      ) : null}
    </div>
  );
}
