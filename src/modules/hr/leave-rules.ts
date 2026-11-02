/** Leave rules (DECISIONS.md ADR-081). Pure; no I/O. */

/** Calendar days from start to end, both included (YYYY-MM-DD). */
export function leaveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Do two inclusive date ranges share a day? */
export function overlaps(a: { start: string; end: string }, b: { start: string; end: string }) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Common leave types offered with one click. Names and whether they are paid
 * only — entitlements depend on the country's law and the contract and are
 * set by HR per employee; every field stays editable.
 */
export const COMMON_LEAVE_TYPES = [
  { code: "ANNUAL", name: "Annual leave", nameAr: "إجازة سنوية", paid: true, usesBalance: true },
  { code: "SICK", name: "Sick leave", nameAr: "إجازة مرضية", paid: true, usesBalance: true },
  {
    code: "UNPAID",
    name: "Unpaid leave",
    nameAr: "إجازة بدون راتب",
    paid: false,
    usesBalance: false,
  },
  { code: "HAJJ", name: "Hajj leave", nameAr: "إجازة الحج", paid: true, usesBalance: true },
  {
    code: "MATERNITY",
    name: "Maternity leave",
    nameAr: "إجازة وضع",
    paid: true,
    usesBalance: true,
  },
  {
    code: "PATERNITY",
    name: "Paternity leave",
    nameAr: "إجازة أبوة",
    paid: true,
    usesBalance: true,
  },
  {
    code: "EMERGENCY",
    name: "Emergency leave",
    nameAr: "إجازة طارئة",
    paid: true,
    usesBalance: true,
  },
  {
    code: "BEREAVEMENT",
    name: "Bereavement leave",
    nameAr: "إجازة وفاة",
    paid: true,
    usesBalance: true,
  },
  { code: "MARRIAGE", name: "Marriage leave", nameAr: "إجازة زواج", paid: true, usesBalance: true },
  { code: "EXAM", name: "Exam leave", nameAr: "إجازة امتحانات", paid: true, usesBalance: true },
] as const;
