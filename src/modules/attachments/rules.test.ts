import { describe, expect, it } from "vitest";
import { canStillRemove, retainUntil, safeFileName, sniffContentType } from "./rules";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("attachments (ADR-051)", () => {
  it("detects the type from the content, not the name", () => {
    expect(sniffContentType(new TextEncoder().encode("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(sniffContentType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe(
      "image/webp",
    );
    expect(sniffContentType(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(sniffContentType(new TextEncoder().encode("MZ\u0090"))).toBeNull(); // an executable
    expect(sniffContentType(bytes())).toBeNull();
  });

  it("makes file names safe and gives them the real extension", () => {
    expect(safeFileName("C:\\Users\\me\\invoice 12.pdf", "application/pdf")).toBe("invoice 12.pdf");
    expect(safeFileName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(safeFileName('bad"name<x>.html', "application/pdf")).toBe("badnamex.pdf");
    expect(safeFileName("", "image/jpeg")).toBe("attachment.jpg");
    expect(safeFileName("فاتورة.pdf", "application/pdf")).toBe("فاتورة.pdf");
    expect(safeFileName(`${"a".repeat(300)}.pdf`, "application/pdf").length).toBe(194);
  });

  it("keeps files for three years and allows removal only shortly after upload", () => {
    expect(retainUntil("2026-11-01")).toBe("2029-11-01");
    expect(retainUntil("2028-02-29")).toBe("2031-02-28");
    const at = new Date("2026-11-01T10:00:00Z");
    expect(canStillRemove(at, new Date("2026-11-01T10:59:00Z"))).toBe(true);
    expect(canStillRemove(at, new Date("2026-11-01T11:01:00Z"))).toBe(false);
  });
});
