/**
 * Attachment rules (DECISIONS.md ADR-051, Q-08). Pure.
 */

/** 3 MB per file (Q-08). */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Kept for 3 years from upload (Q-08), then purged. */
export const RETENTION_YEARS = 3;
/** The uploader may remove a mistaken file this long after uploading it. */
export const REMOVE_WINDOW_MINUTES = 60;

export const ATTACHMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/**
 * The file's type from its first bytes — never from its name or the
 * browser's claim — or null when it is not an allowed type.
 */
export function sniffContentType(bytes: Uint8Array): AttachmentType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp"; // RIFF....WEBP
  return null;
}

const EXTENSION: Record<AttachmentType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * A safe display/download name: no path, no control or quote characters, at
 * most 200 characters, ending in the extension of the detected type.
 */
export function safeFileName(raw: string, type: AttachmentType): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const ext = EXTENSION[type];
  const stem = base.replace(/\.[^.]*$/, "").slice(0, 190) || "attachment";
  return `${stem}.${ext}`;
}

/** Date (YYYY-MM-DD) until which a file uploaded on `uploadedOn` is kept. */
export function retainUntil(uploadedOn: string): string {
  const [y, m, d] = uploadedOn.split("-").map(Number);
  // 29 Feb + 3 years → 28 Feb (never a date that does not exist).
  const last = new Date(Date.UTC(y + RETENTION_YEARS, m, 0)).getUTCDate();
  return `${y + RETENTION_YEARS}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export const canStillRemove = (uploadedAt: Date, now: Date) =>
  now.getTime() - uploadedAt.getTime() <= REMOVE_WINDOW_MINUTES * 60_000;
