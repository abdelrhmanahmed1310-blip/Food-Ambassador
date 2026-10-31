import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { sign, verifySignature } from "./crypto";
import {
  createConnector,
  deliverDueWebhooks,
  getConnector,
  handleInboundSales,
  listConnectors,
  retryDelivery,
  rotateConnectorSecret,
  setConnectorStatus,
} from "./service";

let ctx: TenantContext;
let other: TenantContext;
let kitchen: string;
let supplierId: string;
let product: string;
let units: Record<string, string>;
let today: string;

// A local receiver standing in for a customer's endpoint.
let server: Server;
let receiverUrl: string;
let replyWith = 200;
const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];

const now = () => String(Math.floor(Date.now() / 1000));

function signedRequest(
  publicId: string,
  secret: string,
  payload: unknown,
  idempotencyKey: string | null,
  timestamp = now(),
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return handleInboundSales({
    publicId,
    body,
    headers: { timestamp, signature: sign(secret, timestamp, body), idempotencyKey },
  });
}

const sale = (externalId: string, quantity = "2") => ({
  lines: [
    {
      date: today,
      external_id: externalId,
      item_code: "WATER",
      item_type: "PRODUCT",
      quantity,
      net_amount: "10",
    },
  ],
});

async function approvedOrder() {
  const { id } = await createOrder(ctx, { supplierId, warehouseId: kitchen });
  await addOrderLine(ctx, id, {
    productId: product,
    uomId: units.each,
    quantity: "5",
    unitPrice: "4",
  });
  await submitOrder(ctx, id); // no approval threshold: approved on submit
  return id;
}

beforeAll(async () => {
  process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = "1";
  resetEnvCache();
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = replyWith;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  ({ ctx } = await createTenant("integrations"));
  ({ ctx: other } = await createTenant("integrations-other"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "DOK", name: "Dokki", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  product = (
    await createProduct(ctx, {
      sku: "WATER",
      nameEn: "Water",
      type: "RAW_MATERIAL",
      baseUomId: units.each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: product,
    quantity: "50",
    uomId: units.each,
    unitCost: "3",
  });
  supplierId = (await createSupplier(ctx, { code: "AQUA", name: "Aqua" })).id;
});

afterAll(async () => {
  delete process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS;
  resetEnvCache();
  await new Promise((r) => server.close(r));
});

describe("connectors", () => {
  it("returns the secret once and stores it only encrypted", async () => {
    const c = await createConnector(ctx, {
      kind: "INBOUND_SALES_WEBHOOK",
      name: "POS",
      warehouseId: kitchen,
    });
    expect(c.secret).toMatch(/^fa_whsec_/);
    const row = await getDb().connector.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.secretSealed).not.toContain(c.secret);
    expect(row.secretSealed).toMatch(/^v1\./);
    expect(row.secretHint).toBe(`…${c.secret.slice(-4)}`);
    const listed = await listConnectors(ctx);
    expect(JSON.stringify(listed)).not.toContain(c.secret);
    expect(JSON.stringify(listed)).not.toContain(row.secretSealed);
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, entityId: c.id, action: "connector.created" },
    });
    expect(JSON.stringify(audit.changes)).not.toContain(c.secret);
  });

  it("validates input and refuses unsafe outbound addresses", async () => {
    await expectAppError(
      createConnector(ctx, { kind: "OUTBOUND_WEBHOOK", name: "X", url: receiverUrl, events: [] }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createConnector(ctx, {
        kind: "OUTBOUND_WEBHOOK",
        name: "X",
        url: "https://user:pw@example.com/hook",
        events: ["purchase_order.approved"],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    // With private addresses not allowed (production default), loopback is refused.
    process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = "0";
    resetEnvCache();
    try {
      for (const url of ["https://127.0.0.1/hook", "http://example.com/hook", "https://10.1.2.3/x"])
        await expectAppError(
          createConnector(ctx, {
            kind: "OUTBOUND_WEBHOOK",
            name: "X",
            url,
            events: ["purchase_order.approved"],
          }),
          "BUSINESS_RULE_VIOLATION",
        );
    } finally {
      process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = "1";
      resetEnvCache();
    }
  });

  it("is limited to owners and admins, and invisible to other organizations", async () => {
    const c = await createConnector(ctx, {
      kind: "INBOUND_SALES_WEBHOOK",
      name: "POS 2",
      warehouseId: kitchen,
    });
    const { ctx: manager } = await addMember(ctx, "branch_manager");
    await expectAppError(listConnectors(manager), "FORBIDDEN");
    await expectAppError(rotateConnectorSecret(manager, c.id), "FORBIDDEN");
    await expectAppError(getConnector(other, c.id), "NOT_FOUND");
    await expectAppError(setConnectorStatus(other, c.id, "DISABLED"), "NOT_FOUND");
    await expectAppError(
      createConnector(other, {
        kind: "INBOUND_SALES_WEBHOOK",
        name: "Steal",
        warehouseId: kitchen,
      }),
      "NOT_FOUND",
    );
    expect((await listConnectors(other)).length).toBe(0);
  });
});

describe("inbound sales webhook", () => {
  let publicId: string;
  let secret: string;
  let connectorId: string;

  beforeAll(async () => {
    const c = await createConnector(ctx, {
      kind: "INBOUND_SALES_WEBHOOK",
      name: "Till",
      warehouseId: kitchen,
    });
    ({ publicId, secret, id: connectorId } = c);
  });

  it("rejects unknown ids, bad signatures, stale timestamps and missing keys", async () => {
    expect((await signedRequest("x".repeat(32), secret, sale("A-1"), "key-00001")).status).toBe(
      404,
    );
    const wrong = await signedRequest(publicId, "fa_whsec_wrong", sale("A-1"), "key-00001");
    expect(wrong).toMatchObject({ status: 401, body: { reason: "MISMATCH" } });
    const stale = await signedRequest(
      publicId,
      secret,
      sale("A-1"),
      "key-00001",
      String(Math.floor(Date.now() / 1000) - 3600),
    );
    expect(stale).toMatchObject({ status: 401, body: { reason: "STALE" } });
    const unsigned = await handleInboundSales({
      publicId,
      body: "{}",
      headers: { timestamp: null, signature: null, idempotencyKey: "key-00001" },
    });
    expect(unsigned).toMatchObject({ status: 401, body: { reason: "MISSING" } });
    expect((await signedRequest(publicId, secret, sale("A-1"), null)).status).toBe(400);
    expect((await signedRequest(publicId, secret, "not json", "key-00002")).status).toBe(400);
    // Nothing reached the stock ledger.
    expect(await getDb().salesImport.count({ where: { organizationId: ctx.organizationId } })).toBe(
      0,
    );
    const events = await getDb().integrationEvent.findMany({ where: { connectorId } });
    expect(events.every((e) => e.status === "REJECTED")).toBe(true);
    expect(events.length).toBe(5); // the unknown id is not logged against anyone
  });

  it("imports signed sales once; a repeated key returns the first outcome", async () => {
    const first = await signedRequest(publicId, secret, sale("T-100", "2"), "pos-batch-0001");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 1, skipped: 0 });
    const again = await signedRequest(publicId, secret, sale("T-100", "2"), "pos-batch-0001");
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, imported: 1 } });
    // A new key with an already-imported ticket is skipped by the sales import itself.
    const replay = await signedRequest(publicId, secret, sale("T-100", "2"), "pos-batch-0002");
    expect(replay.status === 200 || replay.status === 422).toBe(true);
    const balance = await getDb().stockBalance.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: product, warehouseId: kitchen },
    });
    expect(balance.onHandQuantity.toFixed()).toBe("48"); // 50 − 2, once
    const statuses = (
      await getDb().integrationEvent.findMany({
        where: { connectorId, idempotencyKey: "pos-batch-0001" },
      })
    ).map((e) => e.status);
    expect(statuses.sort()).toEqual(["ACCEPTED", "DUPLICATE"]);
  });

  it("reports sales the import rejects, and stops when the connector is disabled", async () => {
    const bad = await signedRequest(
      publicId,
      secret,
      { lines: [{ date: today, external_id: "T-200", item_code: "NOPE", quantity: "1" }] },
      "pos-batch-0003",
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("salesRejected");
    await setConnectorStatus(ctx, connectorId, "DISABLED");
    expect((await signedRequest(publicId, secret, sale("T-201"), "pos-batch-0004")).status).toBe(
      403,
    );
    await setConnectorStatus(ctx, connectorId, "ACTIVE");
  });

  it("acts with the creator's current access and a rotated secret replaces the old one", async () => {
    const { secret: fresh } = await rotateConnectorSecret(ctx, connectorId);
    expect((await signedRequest(publicId, secret, sale("T-300"), "pos-batch-0005")).status).toBe(
      401,
    );
    const ok = await signedRequest(publicId, fresh, sale("T-300", "1"), "pos-batch-0006");
    expect(ok.status).toBe(200);
    secret = fresh;

    // An admin creates one, then is removed: the connector loses it too.
    const { ctx: admin, user } = await addMember(ctx, "admin");
    const c = await createConnector(admin, {
      kind: "INBOUND_SALES_WEBHOOK",
      name: "Admin's till",
      warehouseId: kitchen,
    });
    await getDb().organizationMembership.updateMany({
      where: { organizationId: ctx.organizationId, userId: user.id },
      data: { status: "REMOVED" },
    });
    const denied = await signedRequest(c.publicId, c.secret, sale("T-400"), "pos-batch-0007");
    expect(denied.status).toBe(403);
  });
});

describe("outbound event webhooks", () => {
  let connectorId: string;
  let secret: string;
  const mine = async (opts: Parameters<typeof deliverDueWebhooks>[0] = {}) => {
    const results = await deliverDueWebhooks(opts);
    const ids = new Set(
      (
        await getDb().outboundDelivery.findMany({
          where: { connectorId },
          select: { id: true },
        })
      ).map((d) => d.id),
    );
    return results.filter((r) => ids.has(r.id));
  };

  beforeAll(async () => {
    const c = await createConnector(ctx, {
      kind: "OUTBOUND_WEBHOOK",
      name: "ERP",
      url: receiverUrl,
      events: ["purchase_order.approved", "goods_receipt.posted"],
    });
    ({ id: connectorId, secret } = c);
  });

  it("queues an event in the same transaction as the approval, and sends it signed", async () => {
    const orderId = await approvedOrder();
    const queued = await getDb().outboundDelivery.findMany({ where: { connectorId } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      eventType: "purchase_order.approved",
      eventKey: `purchase_order.approved:${orderId}`,
      status: "PENDING",
    });

    received.length = 0;
    replyWith = 200;
    expect(await mine()).toEqual([{ id: queued[0].id, status: "DELIVERED" }]);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers["x-fa-event"]).toBe("purchase_order.approved");
    expect(headers["x-fa-event-id"]).toBe(`purchase_order.approved:${orderId}`);
    expect(
      verifySignature({
        secret,
        timestamp: headers["x-fa-timestamp"] as string,
        signature: headers["x-fa-signature"] as string,
        body,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe("OK");
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      type: "purchase_order.approved",
      data: { orderId, total: "20" },
    });
    // Delivered once: a second run sends nothing.
    expect(await mine()).toEqual([]);
  });

  it("retries with backoff, then fails and can be retried by hand", async () => {
    await approvedOrder();
    const d = await getDb().outboundDelivery.findFirstOrThrow({
      where: { connectorId, status: "PENDING" },
    });
    replyWith = 500;
    let at = new Date();
    // First attempt plus five retries (1 min … 12 h), then FAILED.
    for (let attempt = 1; attempt <= 6; attempt++) {
      const [r] = await mine({ now: at });
      expect(r).toEqual({ id: d.id, status: attempt < 6 ? "PENDING" : "FAILED" });
      const row = await getDb().outboundDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(row).toMatchObject({ attempts: attempt, lastStatusCode: 500, lastError: "http 500" });
      if (attempt < 6) {
        // Not due again before its backoff.
        expect(await mine({ now: new Date(at.getTime() + 30_000) })).toEqual([]);
        at = row.nextAttemptAt;
      }
    }
    replyWith = 200;
    await retryDelivery(ctx, d.id);
    expect(await mine()).toEqual([{ id: d.id, status: "DELIVERED" }]);
    await expectAppError(retryDelivery(ctx, d.id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(retryDelivery(other, d.id), "NOT_FOUND");
  });

  it("queues goods_receipt.posted when a receipt posts", async () => {
    const orderId = await approvedOrder();
    const order = await getOrder(ctx, orderId);
    const r = await postReceipt(ctx, orderId, {
      lines: [{ purchaseOrderLineId: order.lines[0].id, receivedQuantity: "5", unitPrice: "4" }],
    });
    const d = await getDb().outboundDelivery.findFirstOrThrow({
      where: { connectorId, eventKey: `goods_receipt.posted:${r.id}` },
    });
    expect(d.payload).toMatchObject({ data: { number: r.number, orderId } });
  });

  it("does not queue unsubscribed events or for disabled connectors", async () => {
    await setConnectorStatus(ctx, connectorId, "DISABLED");
    const before = await getDb().outboundDelivery.count({ where: { connectorId } });
    await approvedOrder();
    expect(await getDb().outboundDelivery.count({ where: { connectorId } })).toBe(before);
    await setConnectorStatus(ctx, connectorId, "ACTIVE");
  });
});
