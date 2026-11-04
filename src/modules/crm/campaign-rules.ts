/**
 * Campaign messages (DECISIONS.md ADR-119). Pure.
 */

export const CAMPAIGN_CHANNELS = ["SMS", "WHATSAPP", "EMAIL"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

// GSM 03.38 basic character set and its extension table (each extension character takes two places).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/**
 * How an SMS is billed: GSM-7 when every character is in the GSM set
 * (160 in one message, 153 per part when longer), otherwise UCS-2 — Arabic,
 * for one — (70 in one, 67 per part).
 */
export function smsParts(text: string): {
  encoding: "GSM-7" | "UCS-2";
  length: number;
  parts: number;
} {
  const chars = [...text];
  const gsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
  if (gsm) {
    const length = chars.reduce((a, c) => a + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
    return { encoding: "GSM-7", length, parts: length <= 160 ? 1 : Math.ceil(length / 153) };
  }
  const length = text.length; // UTF-16 code units, as UCS-2 counts them
  return { encoding: "UCS-2", length, parts: length <= 70 ? 1 : Math.ceil(length / 67) };
}

/** The only placeholder: {name}, the guest's first name (empty when unknown). */
export const PLACEHOLDERS = ["{name}"] as const;

export function unknownPlaceholders(body: string): string[] {
  return [...new Set(body.match(/\{[^}]*\}/g) ?? [])].filter(
    (p) => !(PLACEHOLDERS as readonly string[]).includes(p),
  );
}

export function render(body: string, guest: { name: string | null }): string {
  const first = (guest.name ?? "").trim().split(/\s+/)[0] ?? "";
  return body
    .replaceAll("{name}", first)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Every message ends with a way to stop receiving them. */
export function withUnsubscribe(
  channel: CampaignChannel,
  text: string,
  link: string,
  label: string,
): string {
  return channel === "EMAIL" ? `${text}\n\n${label}: ${link}` : `${text}\n${label} ${link}`;
}
