let lastMs = -1;
let counter = 0;

/**
 * RFC 9562 UUID version 7: 48-bit Unix millisecond timestamp, a 12-bit
 * counter (method 1, "fixed-length dedicated counter") and random bits.
 * IDs generated in this process are strictly increasing, even within one
 * millisecond, so ordering by ID reflects creation order (e.g. the lines of
 * one inventory document). Matches Prisma's `uuid(7)` format.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted within this millisecond: borrow the next one.
      ms = lastMs + 1;
      counter = 0;
    }
  } else {
    counter = bytes[6] & 0x07; // random start in the lower half leaves room to increment
    counter = (counter << 8) | bytes[7];
    counter &= 0x7ff;
  }
  lastMs = ms;
  bytes[6] = counter >> 8;
  bytes[7] = counter & 0xff;
  let ts = BigInt(ms);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
