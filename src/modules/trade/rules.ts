/**
 * Import shipments (DECISIONS.md ADR-113). Pure.
 */

export const SHIPMENT_STATUSES = [
  "PLANNED",
  "IN_TRANSIT",
  "ARRIVED",
  "CLEARED",
  "CLOSED",
  "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const TRANSPORT_MODES = ["SEA", "AIR", "ROAD", "RAIL", "COURIER"] as const;
/** Incoterms 2020. */
export const INCOTERMS = [
  "EXW",
  "FCA",
  "FAS",
  "FOB",
  "CFR",
  "CIF",
  "CPT",
  "CIP",
  "DAP",
  "DPU",
  "DDP",
] as const;
export const CONTAINER_TYPES = [
  "DRY_20",
  "DRY_40",
  "HIGH_CUBE_40",
  "REEFER_20",
  "REEFER_40",
  "OTHER",
] as const;
export const REEFERS: ReadonlySet<string> = new Set(["REEFER_20", "REEFER_40"]);

/** The one step forward from each status (cancel is separate). */
export const NEXT_STATUS: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
  PLANNED: "IN_TRANSIT",
  IN_TRANSIT: "ARRIVED",
  ARRIVED: "CLEARED",
  CLEARED: "CLOSED",
};

/** Header details, containers and orders can change until the shipment is cleared. */
export const isEditable = (s: ShipmentStatus) =>
  s === "PLANNED" || s === "IN_TRANSIT" || s === "ARRIVED";

/** Cancelling is possible before arrival only. */
export const isCancellable = (s: ShipmentStatus) => s === "PLANNED" || s === "IN_TRANSIT";

/** Receipts can be linked once the goods have arrived, until closed. */
export const takesReceipts = (s: ShipmentStatus) => s === "ARRIVED" || s === "CLEARED";

const LETTER_VALUES: Record<string, number> = (() => {
  // ISO 6346: A = 10, skipping multiples of 11.
  const out: Record<string, number> = {};
  let v = 10;
  for (let c = 65; c <= 90; c++) {
    if (v % 11 === 0) v += 1;
    out[String.fromCharCode(c)] = v;
    v += 1;
  }
  return out;
})();

/** ISO 6346 container number (owner code, category, serial, check digit) as typed. */
export function normalizeContainerNumber(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidContainerNumber(raw: string): boolean {
  const n = normalizeContainerNumber(raw);
  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = n[i];
    const value = /[A-Z]/.test(ch) ? LETTER_VALUES[ch] : Number(ch);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10 === Number(n[10]);
}

/** HS / tariff codes are typed with dots or spaces ("0402.21.10"); kept as 6–12 digits. */
export function normalizeHsCode(raw: string): string {
  return raw.replace(/[\s.]/g, "");
}
export const isValidHsCode = (code: string) => /^[0-9]{6,12}$/.test(code);

/** "0402.21.10" for display: chapter.heading, then pairs. */
export function formatHsCode(code: string): string {
  if (code.length <= 4) return code;
  const rest = code.slice(4).match(/.{1,2}/g) ?? [];
  return [code.slice(0, 4), ...rest].join(".");
}

/**
 * Late: expected to have arrived (ETA before today) but not yet arrived.
 * Days late, or null when on time or no ETA.
 */
export function daysLate(
  s: { status: ShipmentStatus; eta: string | null },
  today: string,
): number | null {
  if (!s.eta || (s.status !== "PLANNED" && s.status !== "IN_TRANSIT")) return null;
  const d = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${s.eta}T00:00:00Z`)) / 86_400_000,
  );
  return d > 0 ? d : null;
}
