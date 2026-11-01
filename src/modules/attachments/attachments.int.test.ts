import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createCount } from "@/modules/inventory/counts";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { MAX_ATTACHMENT_BYTES } from "./rules";
import {
  getAttachmentContent,
  listAttachments,
  purgeExpiredAttachments,
  removeAttachment,
  uploadAttachment,
} from "./service";

let ctx: TenantContext;
let wh: string;
let otherWh: string;
let orderId: string;
let today: string;

const pdf = (extra = "") => new TextEncoder().encode(`%PDF-1.4\n% test ${extra}\n%%EOF\n`);
const po = () => ({ entityType: "PURCHASE_ORDER", entityId: orderId });

beforeAll(async () => {
  ({ ctx } = await createTenant("attachments"));
  today = businessDate(ctx.timeZone);
  const branchId = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" }))
    .id;
  const other = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
  wh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  otherWh = (await createWarehouse(ctx, { branchId: other, code: "G", name: "Giza", type: "MAIN" }))
    .id;
  const supplierId = (await createSupplier(ctx, { code: "S1", name: "Supplier" })).id;
  orderId = (await createOrder(ctx, { supplierId, warehouseId: wh })).id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attachments (ADR-051, Q-08)", () => {
  it("stores a file for three years and returns exactly its bytes", async () => {
    const bytes = pdf("invoice scan");
    const a = await uploadAttachment(ctx, po(), { name: "../scan.PDF", bytes });
    expect(a.fileName).toBe("scan.pdf");
    expect(a.retainUntil.toISOString().slice(0, 10)).toBe(
      `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`,
    );
    const file = await getAttachmentContent(ctx, a.id);
    expect(file.contentType).toBe("application/pdf");
    expect(new Uint8Array(file.data)).toEqual(bytes);
    const list = await listAttachments(ctx, "PURCHASE_ORDER", orderId);
    expect(list.canUpload).toBe(true);
    expect(list.items.map((i) => i.id)).toContain(a.id);
    const row = await getDb().attachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts up to 3 MB of PDF or image content only", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES);
    big.set(pdf());
    await uploadAttachment(ctx, po(), { name: "big.pdf", bytes: big }); // exactly 3 MB
    const tooBig = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    tooBig.set(pdf());
    await expectAppError(
      uploadAttachment(ctx, po(), { name: "big.pdf", bytes: tooBig }),
      "BUSINESS_RULE_VIOLATION",
    );
    // An HTML page named .pdf is refused: the type comes from the content.
    await expectAppError(
      uploadAttachment(ctx, po(), {
        name: "invoice.pdf",
        bytes: new TextEncoder().encode("<html><script>alert(1)</script>"),
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      uploadAttachment(
        ctx,
        { entityType: "RECIPE", entityId: orderId },
        { name: "x.pdf", bytes: pdf() },
      ),
      "VALIDATION_FAILED",
    );
  });

  it("follows the document's access rules and never crosses organizations", async () => {
    const a = await uploadAttachment(ctx, po(), { name: "po.pdf", bytes: pdf("po") });
    const analyst = (await addMember(ctx, "analyst")).ctx;
    const viewOnly = await listAttachments(analyst, "PURCHASE_ORDER", orderId);
    expect(viewOnly.canUpload).toBe(false);
    await expectAppError(
      uploadAttachment(analyst, po(), { name: "x.pdf", bytes: pdf() }),
      "FORBIDDEN",
    );
    const elsewhere = (
      await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId: otherWh })
    ).ctx;
    await expectAppError(listAttachments(elsewhere, "PURCHASE_ORDER", orderId), "NOT_FOUND");
    await expectAppError(getAttachmentContent(elsewhere, a.id), "NOT_FOUND");
    const other = (await createTenant("attachments-other")).ctx;
    await expectAppError(getAttachmentContent(other, a.id), "NOT_FOUND");
    await expectAppError(listAttachments(other, "PURCHASE_ORDER", orderId), "NOT_FOUND");
    await expectAppError(removeAttachment(other, a.id), "NOT_FOUND");
    await expectAppError(getAttachmentContent(ctx, "not-a-uuid"), "NOT_FOUND");

    // A counter attaches a count sheet photo to their warehouse's count.
    const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
    const salt = (
      await createProduct(ctx, {
        sku: "SALT",
        nameEn: "Salt",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: wh,
      productId: salt,
      quantity: "1",
      uomId: units.kg,
      unitCost: "1",
    });
    const counter = (await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId: wh }))
      .ctx;
    const { id: countId } = await createCount(counter, { warehouseId: wh });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const photo = await uploadAttachment(
      counter,
      { entityType: "STOCK_COUNT", entityId: countId },
      { name: "sheet", bytes: png },
    );
    expect(photo.fileName).toBe("sheet.png");
  });

  it("lets only the uploader remove a mistaken file, within an hour", async () => {
    const a = await uploadAttachment(ctx, po(), { name: "wrong.pdf", bytes: pdf("wrong") });
    const colleague = (await addMember(ctx, "procurement")).ctx;
    await expectAppError(removeAttachment(colleague, a.id), "BUSINESS_RULE_VIOLATION");
    await removeAttachment(ctx, a.id);
    await expectAppError(getAttachmentContent(ctx, a.id), "NOT_FOUND");
    expect(await getDb().attachmentContent.count({ where: { attachmentId: a.id } })).toBe(0);
    expect(
      (await listAttachments(ctx, "PURCHASE_ORDER", orderId)).items.some((i) => i.id === a.id),
    ).toBe(false);

    const kept = await uploadAttachment(ctx, po(), { name: "kept.pdf", bytes: pdf("kept") });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    await expectAppError(removeAttachment(ctx, kept.id), "BUSINESS_RULE_VIOLATION");
  });

  it("is fixed in the database: no edits, and the content must match the recorded size", async () => {
    const a = await uploadAttachment(ctx, po(), { name: "fixed.pdf", bytes: pdf("fixed") });
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.attachment.update({ where: { id: a.id }, data: { fileName: "other.pdf" } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTx(ctx.organizationId, async (tx) => {
        const b = await tx.attachment.create({
          data: {
            organizationId: ctx.organizationId,
            entityType: "PURCHASE_ORDER",
            entityId: orderId,
            fileName: "x.pdf",
            contentType: "application/pdf",
            sizeBytes: 10,
            sha256: "0".repeat(64),
            uploadedByUserId: ctx.userId,
            retainUntil: new Date(`${addDays(today, 1)}T00:00:00Z`),
          },
        });
        await tx.attachmentContent.create({
          data: {
            attachmentId: b.id,
            organizationId: ctx.organizationId,
            data: Buffer.from("abc"),
          },
        });
      }),
    ).rejects.toThrow();
  });

  it("purges content after the retention period and keeps the record", async () => {
    const a = await uploadAttachment(ctx, po(), { name: "old.pdf", bytes: pdf("old") });
    const row = await getDb().attachment.findUniqueOrThrow({ where: { id: a.id } });
    const dayAfter = addDays(row.retainUntil.toISOString().slice(0, 10), 1);
    // On its last retention day it is kept (the job runs for all organizations,
    // so other files may be purged; this one must not be).
    await purgeExpiredAttachments({ today: row.retainUntil.toISOString().slice(0, 10) });
    expect(
      (await getDb().attachment.findUniqueOrThrow({ where: { id: a.id } })).purgedAt,
    ).toBeNull();
    expect(await getDb().attachmentContent.count({ where: { attachmentId: a.id } })).toBe(1);
    const { purged } = await purgeExpiredAttachments({ today: dayAfter });
    expect(purged).toBeGreaterThanOrEqual(1);
    const after = await getDb().attachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.purgedAt).not.toBeNull();
    expect(after.fileName).toBe("old.pdf");
    expect(await getDb().attachmentContent.count({ where: { attachmentId: a.id } })).toBe(0);
    await expectAppError(getAttachmentContent(ctx, a.id), "NOT_FOUND");
    const listed = (await listAttachments(ctx, "PURCHASE_ORDER", orderId)).items.find(
      (i) => i.id === a.id,
    );
    expect(listed?.purgedAt).not.toBeNull();
  });
});
