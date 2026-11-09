import Link from "next/link";
import type { ReactNode } from "react";

/** Small display pieces shared by the nutrition pages (ADR-132). Server components. */

export type ValueStatus =
  "REPORTED" | "CALCULATED" | "BELOW_DETECTION" | "NOT_APPLICABLE" | "MISSING";

/**
 * A nutrient amount. Missing and not-applicable values are shown as words —
 * never as 0 — and below-detection as "< LOQ".
 */
export function NutrientAmount({
  amount,
  unit,
  status,
  labels,
  fmt,
}: {
  amount: string | null;
  unit: string;
  status: string;
  labels: Record<"MISSING" | "BELOW_DETECTION" | "NOT_APPLICABLE" | "CALCULATED", string>;
  fmt: (v: { toString(): string }) => string;
}) {
  if (status === "NOT_APPLICABLE")
    return <span className="text-muted">{labels.NOT_APPLICABLE}</span>;
  if (status === "BELOW_DETECTION")
    return <span className="text-muted">{labels.BELOW_DETECTION}</span>;
  if (amount === null) return <span className="text-warning">{labels.MISSING}</span>;
  return (
    <span className="ltr-value tabular-nums">
      {fmt(amount)} {unit}
      {status === "CALCULATED" ? (
        <span className="text-muted ms-1 text-xs" title={labels.CALCULATED}>
          *
        </span>
      ) : null}
    </span>
  );
}

export function StatTile({
  label,
  value,
  href,
}: {
  label: string;
  value: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className="text-muted block text-xs">{label}</span>
      <span className="ltr-value mt-1 block text-2xl font-semibold tabular-nums">{value}</span>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="border-border bg-surface hover:bg-surface-muted block rounded-xl border p-4 shadow-sm"
    >
      {body}
    </Link>
  ) : (
    <div className="border-border bg-surface rounded-xl border p-4 shadow-sm">{body}</div>
  );
}

/** The section's own tabs, so each page is one click from the others. */
export function NutritionTabs({
  base,
  current,
  items,
}: {
  base: string;
  current: string;
  items: Array<{ key: string; label: string }>;
}) {
  return (
    <nav
      className="border-border mb-6 flex flex-wrap gap-1 border-b text-sm"
      aria-label="Nutrition"
    >
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.key ? `${base}/${i.key}` : base}
          aria-current={i.key === current ? "page" : undefined}
          className={`-mb-px rounded-t-md border-b-2 px-3 py-2 ${
            i.key === current
              ? "border-primary text-primary font-medium"
              : "text-muted hover:text-foreground border-transparent"
          }`}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
