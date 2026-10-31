import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { listAttachments, uploadAttachment } from "./service";

// The EICAR test file: harmless, and detected by every antivirus engine.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

let ctx: TenantContext;
let orderId: string;
let fake: Server | null = null;
let scannerUrl: string;

/** A clamd stand-in for CI when no real daemon is given in CLAMAV_TEST_URL. */
async function startFakeClamd() {
  fake = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.subarray(-4).equals(Buffer.alloc(4)))
        socket.end(buf.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
  });
  await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
  return `tcp://127.0.0.1:${(fake.address() as { port: number }).port}`;
}

beforeAll(async () => {
  scannerUrl = process.env.CLAMAV_TEST_URL || (await startFakeClamd());
  process.env.CLAMAV_URL = scannerUrl;
  resetEnvCache();
  ({ ctx } = await createTenant("scanning"));
  const branchId = (await createBranch(ctx, { code: "SC", name: "Scan", type: "RESTAURANT" })).id;
  const wh = (await createWarehouse(ctx, { branchId, code: "W", name: "W", type: "MAIN" })).id;
  const supplierId = (await createSupplier(ctx, { code: "S", name: "S" })).id;
  orderId = (await createOrder(ctx, { supplierId, warehouseId: wh })).id;
});

afterAll(async () => {
  delete process.env.CLAMAV_URL;
  resetEnvCache();
  if (fake) await new Promise((r) => fake!.close(r));
});

const po = () => ({ entityType: "PURCHASE_ORDER", entityId: orderId });

describe(`attachment virus scanning (ADR-055) via ${process.env.CLAMAV_TEST_URL ? "a real clamd" : "a clamd stand-in"}`, () => {
  it("stores clean files as checked", async () => {
    const a = await uploadAttachment(ctx, po(), {
      name: "clean.pdf",
      bytes: new TextEncoder().encode("%PDF-1.4\n% a clean quotation\n%%EOF\n"),
    });
    expect(a.scanStatus).toBe("CLEAN");
    const row = await getDb().attachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.scannedAt).not.toBeNull();
  });

  it("refuses an infected file, stores nothing and records the attempt", async () => {
    const before = (await listAttachments(ctx, "PURCHASE_ORDER", orderId)).items.length;
    await expectAppError(
      uploadAttachment(ctx, po(), {
        name: "invoice.pdf",
        bytes: new TextEncoder().encode(`%PDF-1.4\n${EICAR}\n%%EOF\n`),
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await listAttachments(ctx, "PURCHASE_ORDER", orderId)).items.length).toBe(before);
    const audit = await getDb().auditEvent.findFirst({
      where: { organizationId: ctx.organizationId, action: "attachment.refused_infected" },
    });
    expect(JSON.stringify(audit?.changes)).toMatch(/Eicar|EICAR/);
  });

  it("refuses uploads when the configured scanner cannot answer (fail closed)", async () => {
    process.env.CLAMAV_URL = "tcp://127.0.0.1:1";
    resetEnvCache();
    try {
      const e = await uploadAttachment(ctx, po(), {
        name: "x.pdf",
        bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
      }).catch((err) => err);
      expect(e.details).toMatchObject({ rule: "ATTACHMENT_SCAN_FAILED" });
    } finally {
      process.env.CLAMAV_URL = scannerUrl;
      resetEnvCache();
    }
  });
});
