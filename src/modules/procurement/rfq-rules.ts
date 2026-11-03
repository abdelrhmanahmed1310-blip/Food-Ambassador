/**
 * Requests for quotation (DECISIONS.md ADR-092). Pure; no I/O.
 */
import { Decimal } from "@/lib/decimal";

export type RfqStatus = "DRAFT" | "SENT" | "AWARDED" | "CANCELLED";

/** What may be done to an RFQ in a status. */
export function rfqActions(status: RfqStatus) {
  return {
    /** Lines, invited suppliers and header. */
    edit: status === "DRAFT",
    send: status === "DRAFT",
    /** Record or correct quotations. */
    record: status === "SENT",
    award: status === "SENT",
    cancel: status === "DRAFT" || status === "SENT",
  };
}

export interface Offer {
  quotationLineId: string;
  quotationId: string;
  /** Unit price × requested quantity, converted into the RFQ's company currency; null = no rate. */
  comparable: Decimal | null;
  /** Expired on the comparison day. */
  expired: boolean;
}

/**
 * The lowest comparable offer for a line (among quotations still valid).
 * Null when nothing can be compared. Ties all count as lowest.
 */
export function lowestOffers(offers: readonly Offer[]): Set<string> {
  const usable = offers.filter((o) => !o.expired && o.comparable !== null);
  if (usable.length === 0) return new Set();
  const min = usable.reduce((m, o) => Decimal.min(m, o.comparable!), usable[0].comparable!);
  return new Set(usable.filter((o) => o.comparable!.equals(min)).map((o) => o.quotationLineId));
}

/**
 * Awarding an offer that is not known to be the lowest needs a written
 * reason: it is dearer than another valid offer, or some valid offer could
 * not be compared for want of an exchange rate.
 */
export function awardNeedsReason(chosen: Offer, offers: readonly Offer[]): boolean {
  const valid = offers.filter((o) => !o.expired);
  if (chosen.comparable === null) return valid.length > 1;
  if (valid.some((o) => o.comparable === null)) return true;
  return valid.some((o) => o.comparable!.lessThan(chosen.comparable!));
}

/** Quantity ordered from an offer: what was asked, or less if the supplier offered less. */
export function awardedQuantity(requested: Decimal, offered: Decimal | null): Decimal {
  return offered === null ? requested : Decimal.min(requested, offered);
}
