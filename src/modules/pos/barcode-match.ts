/**
 * Find the menu item a scanned code names (ADR-133), on the device, from the
 * menu the till or kiosk already has (so scanning works offline too).
 * Codes match exactly; numeric codes also match without leading zeros, so a
 * UPC-A (12 digits) scanned as EAN-13 (with a leading 0) still finds its item.
 */
export function matchBarcode<T extends { barcodes: readonly string[] }>(
  items: readonly T[],
  scanned: string,
): T | null {
  const code = scanned.trim();
  if (!code) return null;
  const exact = items.find((i) => i.barcodes.includes(code));
  if (exact) return exact;
  if (!/^\d+$/.test(code)) return null;
  const bare = code.replace(/^0+/, "");
  return (
    items.find((i) => i.barcodes.some((b) => /^\d+$/.test(b) && b.replace(/^0+/, "") === bare)) ??
    null
  );
}
