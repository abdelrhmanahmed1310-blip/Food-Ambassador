import { deliveryEventSchema, type DeliveryEvent } from "./canonical";

/**
 * Delivery platform adapters (ADR-069). Plug and play: each platform is one
 * entry here. An adapter turns the platform's request body into canonical
 * events. A platform without a native adapter is connected through the
 * canonical format (by the platform or by middleware such as an aggregator).
 *
 * To add a native adapter: implement `parse` from the platform's partner API
 * specification, test it against the platform's sandbox, then set
 * `native: true`. None is marked native until tested against the real API.
 */

export const DELIVERY_PLATFORMS = ["HUNGERSTATION", "JAHEZ", "KEETA", "OTHER"] as const;
export type DeliveryPlatformKey = (typeof DELIVERY_PLATFORMS)[number];

export interface DeliveryAdapter {
  /** True once tested against the platform's own API; false = canonical format. */
  native: boolean;
  /** Where the platform's integration specification is obtained. */
  specification: string;
  parse(json: unknown): { ok: true; event: DeliveryEvent } | { ok: false };
}

const canonical = (json: unknown) => {
  const r = deliveryEventSchema.safeParse(json);
  return r.success ? ({ ok: true, event: r.data } as const) : ({ ok: false } as const);
};

export const ADAPTERS: Record<DeliveryPlatformKey, DeliveryAdapter> = {
  HUNGERSTATION: {
    native: false,
    specification: "Partner API from the HungerStation (Delivery Hero) integration team",
    parse: canonical,
  },
  JAHEZ: {
    native: false,
    specification: "Integration API key and documentation from integration@jahez.net",
    parse: canonical,
  },
  KEETA: {
    native: false,
    specification: "Keeta Open Delivery API (api-docs.mykeeta.com), credentials after NDA",
    parse: canonical,
  },
  OTHER: { native: false, specification: "Canonical format (docs/DELIVERY.md)", parse: canonical },
};

export function parseDeliveryBody(platform: DeliveryPlatformKey, body: string) {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false } as const;
  }
  return ADAPTERS[platform].parse(json);
}

/** Items and modifiers of an order that have no menu mapping yet. */
export function unmappedIds(
  order: { items: Array<{ externalId: string; modifiers: Array<{ externalId: string }> }> },
  maps: { items: ReadonlySet<string>; options: ReadonlySet<string> },
) {
  const items = new Set<string>();
  const options = new Set<string>();
  for (const i of order.items) {
    if (!maps.items.has(i.externalId)) items.add(i.externalId);
    for (const m of i.modifiers) if (!maps.options.has(m.externalId)) options.add(m.externalId);
  }
  return { items: [...items], options: [...options] };
}
