import "server-only";
import { z } from "zod";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { planConsumptionInTx, postConsumptionInTx } from "@/modules/inventory/consumption";
import { loadWarehouse } from "@/modules/inventory/context";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import type { SalesChannel } from "@/modules/menu/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { createTicketsInTx, lineStatusesInTx, markVoidedInTx } from "./kitchen";
import { checkSettled, remainingQuantity } from "./rules";
import { promotionFor, saleMoment } from "./discounts";
import { loadPromotionsInTx } from "./promotions";
import {
  explodeUseInTx,
  loadRegister,
  orderSchema,
  priceLinesInTx,
  recordOrderInTx,
} from "./service";

/**
 * Floors, tables and checks (DECISIONS.md ADR-062). A check collects items
 * during the meal; items go to the kitchen when sent; paying all or part of
 * it records an ordinary point-of-sale order (ADR-059), so prices, VAT,
 * stock, receipts, voids, refunds and reports work exactly as for counter
 * sales.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const at = (branchId: string, warehouseId?: string) => ({
  branchId,
  warehouseId: warehouseId ?? "",
});

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId,
    changes,
  });
}

/** Who may do what with checks at a branch. */
function abilities(ctx: TenantContext, branchId: string) {
  const site = at(branchId);
  const serve = hasPermission(ctx.grants, "pos.tables", site);
  const sell = hasPermission(ctx.grants, "pos.sell", site);
  return {
    serve,
    pay: sell,
    void: hasPermission(ctx.grants, "pos.void", site),
    discount: hasPermission(ctx.grants, "pos.discount", site),
    see: serve || sell || hasPermission(ctx.grants, "pos.view", site),
  };
}

// ─── Floors and tables (pos.manage) ───

const floorSchema = z.object({
  branchId: uuidSchema,
  warehouseId: uuidSchema,
  name: requiredText(80),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export async function createFloor(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = floorSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      if (wh.branchId !== input.branchId)
        throw businessRuleViolation(
          "REGISTER_WAREHOUSE_OTHER_BRANCH",
          "The kitchen's stock warehouse must belong to the floor's branch",
          { field: "warehouseId" },
        );
      const f = await tx.posFloor.create({
        data: { organizationId: ctx.organizationId, ...input },
        select: { id: true },
      });
      await audit(tx, ctx, "pos_floor", f.id, "created", input);
      return f;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("This name is already used", { reason: "codeTaken", field: "name" });
    throw error;
  }
}

const tableSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, { error: "required" })
    .max(20, { error: "tooLong" })
    .transform((v) => v.toUpperCase()),
  seats: z.coerce.number().int().min(1, { error: "invalid" }).max(50, { error: "invalid" }),
  gridX: z.coerce.number().int().min(0).max(39),
  gridY: z.coerce.number().int().min(0).max(39),
});

export async function createTable(ctx: TenantContext, floorId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = tableSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const floor = await tx.posFloor.findFirst({
        where: { organizationId: ctx.organizationId, id: floorId },
      });
      if (!floor) throw notFound("Floor");
      const t = await tx.posTable.create({
        data: {
          organizationId: ctx.organizationId,
          floorId,
          branchId: floor.branchId,
          ...parsed.data,
        },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "pos_table", t.id, "created", parsed.data);
      return t;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("This code is already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

export async function setTableArchived(ctx: TenantContext, tableId: string, archived: boolean) {
  assertPermission(ctx.grants, "pos.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await tx.posTable.findFirst({
      where: { organizationId: ctx.organizationId, id: tableId },
      include: { tabs: { where: { status: "OPEN" }, select: { id: true } } },
    });
    if (!t) throw notFound("Table");
    if (archived && t.tabs.length > 0)
      throw businessRuleViolation("TABLE_HAS_OPEN_CHECK", "Close the table's check first");
    await tx.posTable.update({
      where: { id: t.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit(tx, ctx, "pos_table", t.id, archived ? "archived" : "restored");
  });
}

/** Floors of the branches the user can see, with their tables and open checks. */
export async function floorPlan(ctx: TenantContext) {
  const scopes = (["pos.tables", "pos.sell", "pos.view"] as const).map((p) =>
    accessibleScope(ctx.grants, p),
  );
  const all = scopes.some((s) => s.all) || hasPermission(ctx.grants, "pos.manage");
  const branchIds = scopes.flatMap((s) => (s.all ? [] : s.branchIds));
  return withTenantTx(ctx.organizationId, async (tx) => {
    const floors = await tx.posFloor.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(all ? {} : { branchId: { in: branchIds } }),
      },
      include: {
        branch: { select: { code: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        tables: {
          where: { archivedAt: null },
          orderBy: { code: "asc" },
          include: {
            tabs: {
              where: { status: "OPEN" },
              select: {
                id: true,
                number: true,
                guests: true,
                openedAt: true,
                lines: { select: { status: true } },
              },
            },
          },
        },
      },
      orderBy: [{ branch: { code: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    });
    const openTabIds = floors.flatMap((f) => f.tables.flatMap((t) => t.tabs.map((x) => x.id)));
    const preparing = new Map(
      (
        await tx.kitchenTicket.groupBy({
          by: ["tabId"],
          where: { organizationId: ctx.organizationId, tabId: { in: openTabIds }, status: "OPEN" },
          _count: { _all: true },
        })
      ).map((g) => [g.tabId!, g._count._all]),
    );
    const barTabs = await tx.posTab.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "OPEN",
        tableId: null,
        ...(all ? {} : { branchId: { in: branchIds } }),
      },
      select: { id: true, number: true, label: true, guests: true, openedAt: true, branchId: true },
      orderBy: { openedAt: "asc" },
    });
    return {
      floors: floors.map((f) => ({
        ...f,
        can: abilities(ctx, f.branchId),
        tables: f.tables.map((t) => {
          const tab = t.tabs[0];
          return {
            id: t.id,
            code: t.code,
            seats: t.seats,
            gridX: t.gridX,
            gridY: t.gridY,
            tab: tab
              ? {
                  id: tab.id,
                  number: tab.number,
                  guests: tab.guests,
                  openedAt: tab.openedAt,
                  pending: tab.lines.filter((l) => l.status === "PENDING").length,
                  sent: tab.lines.filter((l) => l.status === "SENT").length,
                  preparing: preparing.get(tab.id) ?? 0,
                }
              : null,
          };
        }),
      })),
      barTabs,
    };
  });
}

// ─── Checks ───

const openSchema = z.object({
  tableId: uuidSchema.optional(),
  /** For a check without a table (bar, pick-up). */
  branchId: uuidSchema.optional(),
  label: optionalText(60),
  guests: z.coerce.number().int().min(1, { error: "invalid" }).max(500, { error: "invalid" }),
});

/** Set by the server for a guest's order from the web or a kiosk (ADR-070); never from a form. */
export interface TabOrigin {
  source: "WEB" | "KIOSK";
  channelId: string;
  key: string;
  channel: SalesChannel;
  guestName: string;
  guestPhone: string | null;
  guestToken: string;
  payOnline: boolean;
  pickupAt: Date | null;
}

export async function openTab(ctx: TenantContext, rawInput: unknown, origin?: TabOrigin) {
  const parsed = openSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      let branchId: string;
      let warehouseId: string;
      if (input.tableId) {
        const t = await tx.posTable.findFirst({
          where: { organizationId: ctx.organizationId, id: input.tableId, archivedAt: null },
          include: { floor: true },
        });
        if (!t || !abilities(ctx, t.branchId).see) throw notFound("Table");
        branchId = t.branchId;
        warehouseId = t.floor.warehouseId;
      } else {
        if (!input.branchId || !input.label)
          throw businessRuleViolation(
            "CHECK_NEEDS_TABLE_OR_NAME",
            "Choose a table or name the check",
            {
              field: "label",
            },
          );
        const floor = await tx.posFloor.findFirst({
          where: { organizationId: ctx.organizationId, branchId: input.branchId, archivedAt: null },
          orderBy: { sortOrder: "asc" },
        });
        if (!floor || !abilities(ctx, input.branchId).see) throw notFound("Branch");
        branchId = input.branchId;
        warehouseId = floor.warehouseId;
      }
      assertPermission(ctx.grants, "pos.tables", at(branchId));
      const branch = await tx.branch.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: branchId },
        select: { timeZone: true },
      });
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "TAB",
        Number(businessDate(branch.timeZone ?? ctx.timeZone).slice(0, 4)),
      );
      const tab = await tx.posTab.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          branchId,
          warehouseId,
          tableId: input.tableId ?? null,
          label: input.tableId ? null : (input.label ?? null),
          guests: input.guests,
          waiterUserId: ctx.userId,
          ...(origin
            ? {
                channel: origin.channel,
                source: origin.source,
                sourceChannelId: origin.channelId,
                sourceKey: origin.key,
                guestName: origin.guestName,
                guestPhone: origin.guestPhone,
                guestToken: origin.guestToken,
                payOnline: origin.payOnline,
                pickupAt: origin.pickupAt,
              }
            : {}),
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, "pos_tab", tab.id, "opened", { number, ...input });
      return tab;
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_tabs_one_open_per_table"))
      throw businessRuleViolation("TABLE_HAS_OPEN_CHECK", "This table already has an open check");
    throw error;
  }
}

async function loadTab(tx: Tx, ctx: TenantContext, tabId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT 1 FROM "pos_tabs" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${tabId}::uuid FOR UPDATE`;
  const tab = await tx.posTab.findFirst({
    where: { organizationId: ctx.organizationId, id: tabId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      table: { select: { id: true, code: true, floorId: true } },
      branch: { select: { code: true, name: true, timeZone: true } },
    },
  });
  if (!tab || !abilities(ctx, tab.branchId).see) throw notFound("Check");
  return tab;
}

function assertOpen(tab: { status: string }) {
  if (tab.status !== "OPEN") throw businessRuleViolation("CHECK_CLOSED", "This check is closed");
}

const lineSchema = z.object({
  itemId: uuidSchema,
  quantity: decimalString({ maxScale: 3, min: "0.001", max: "999" }),
  optionIds: z.array(uuidSchema).max(40).default([]),
  seat: z.coerce.number().int().min(1).max(500).optional(),
  course: z.coerce.number().int().min(1).max(9).default(1),
  note: optionalText(200),
  hold: z.boolean().default(false),
});

/** Add items to a check (not yet sent). They are priced now to catch items not on sale. */
export async function addTabLines(ctx: TenantContext, tabId: string, rawInput: unknown) {
  const parsed = z.object({ lines: z.array(lineSchema).min(1).max(100) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tab = await loadTab(tx, ctx, tabId, true);
    assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
    assertOpen(tab);
    const priced = await priceLinesInTx(tx, ctx, {
      lines: parsed.data.lines,
      channel: tab.channel,
      branchId: tab.branchId,
      date: businessDate(tab.branch.timeZone ?? ctx.timeZone),
      asOf: new Date(),
    });
    let next = tab.lines.reduce((m, l) => Math.max(m, l.lineNo), 0);
    const created = [];
    for (const [i, l] of parsed.data.lines.entries()) {
      next += 1;
      const p = priced.lines[i];
      created.push(
        await tx.posTabLine.create({
          data: {
            organizationId: ctx.organizationId,
            tabId: tab.id,
            lineNo: next,
            menuItemId: l.itemId,
            name: p.name,
            quantity: toDecimal(l.quantity).toFixed(),
            optionIds: p.options.map((o) => o.optionId),
            optionNames: p.options.map((o) => o.name),
            seat: l.seat ?? null,
            course: l.course,
            note: l.note ?? null,
            hold: l.hold,
            createdByUserId: ctx.userId,
          },
          select: { id: true, lineNo: true },
        }),
      );
    }
    await audit(tx, ctx, "pos_tab", tab.id, "items_added", {
      lines: created.map((c, i) => ({
        lineNo: c.lineNo,
        name: priced.lines[i].name,
        quantity: parsed.data.lines[i].quantity,
      })),
    });
    return created;
  });
}

const changeSchema = z.object({
  quantity: decimalString({ maxScale: 3, min: "0.001", max: "999" }).optional(),
  seat: z.coerce.number().int().min(1).max(500).nullable().optional(),
  course: z.coerce.number().int().min(1).max(9).optional(),
  note: optionalText(200).nullable(),
  hold: z.boolean().optional(),
});

/** Change an item: quantity only before it is sent; seat, course and note while unpaid. */
export async function updateTabLine(ctx: TenantContext, lineId: string, rawInput: unknown) {
  const parsed = changeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const line = await tx.posTabLine.findFirst({
      where: { organizationId: ctx.organizationId, id: lineId },
    });
    if (!line) throw notFound("Check item");
    const tab = await loadTab(tx, ctx, line.tabId, true);
    assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
    assertOpen(tab);
    if (line.status === "VOIDED" || dec(line.paidQuantity).gt(0))
      throw businessRuleViolation("CHECK_ITEM_FIXED", "This item is paid or voided");
    if (input.quantity !== undefined && line.status !== "PENDING")
      throw businessRuleViolation(
        "CHECK_ITEM_SENT",
        "The kitchen has this item; void it and add it again",
        { field: "quantity" },
      );
    await tx.posTabLine.update({
      where: { id: line.id },
      data: {
        ...(input.quantity !== undefined ? { quantity: toDecimal(input.quantity).toFixed() } : {}),
        ...(input.seat !== undefined ? { seat: input.seat } : {}),
        ...(input.course !== undefined ? { course: input.course } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.hold !== undefined && line.status === "PENDING" ? { hold: input.hold } : {}),
      },
    });
    await audit(tx, ctx, "pos_tab", tab.id, "item_changed", { lineNo: line.lineNo, ...input });
  });
}

/** Take back an item that was not sent to the kitchen. */
export async function removeTabLine(ctx: TenantContext, lineId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const line = await tx.posTabLine.findFirst({
      where: { organizationId: ctx.organizationId, id: lineId },
    });
    if (!line) throw notFound("Check item");
    const tab = await loadTab(tx, ctx, line.tabId, true);
    assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
    assertOpen(tab);
    if (line.status !== "PENDING" || dec(line.paidQuantity).gt(0))
      throw businessRuleViolation(
        "CHECK_ITEM_SENT",
        "The kitchen has this item; void it with a reason",
      );
    await tx.posTabLine.delete({ where: { id: line.id } });
    await audit(tx, ctx, "pos_tab", tab.id, "item_removed", {
      lineNo: line.lineNo,
      name: line.name,
      quantity: dec(line.quantity).toFixed(),
    });
  });
}

/**
 * Send items to the kitchen: every unsent item not on hold, or — firing a
 * course — every unsent item of that course, held or not.
 */
export async function sendTab(
  ctx: TenantContext,
  tabId: string,
  rawInput: unknown = {},
  /** A guest order paid online is closed (paid) but still to be prepared (ADR-071). */
  options: { paidGuestOrder?: boolean } = {},
) {
  const parsed = z
    .object({ course: z.coerce.number().int().min(1).max(9).optional() })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const course = parsed.data.course;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tab = await loadTab(tx, ctx, tabId, true);
    assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
    if (!(options.paidGuestOrder && tab.status === "CLOSED" && tab.source !== "STAFF"))
      assertOpen(tab);
    const toSend = tab.lines.filter(
      (l) => l.status === "PENDING" && (course === undefined ? !l.hold : l.course === course),
    );
    if (toSend.length === 0)
      throw businessRuleViolation("NOTHING_TO_SEND", "There is nothing to send");
    const now = new Date();
    await tx.posTabLine.updateMany({
      where: { organizationId: ctx.organizationId, id: { in: toSend.map((l) => l.id) } },
      data: { status: "SENT", sentAt: now, sentByUserId: ctx.userId, hold: false },
    });
    const tickets = await createTicketsInTx(
      tx,
      ctx,
      {
        branchId: tab.branchId,
        tabId: tab.id,
        label: tab.table?.code ?? tab.label ?? tab.number,
        guests: tab.guests,
      },
      toSend.map((l) => ({
        tabLineId: l.id,
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: dec(l.quantity),
        options: Array.isArray(l.optionNames) ? (l.optionNames as string[]) : [],
        note: l.note,
        seat: l.seat,
        course: l.course,
      })),
    );
    await audit(tx, ctx, "pos_tab", tab.id, "sent", {
      course: course ?? null,
      lines: toSend.map((l) => l.lineNo),
    });
    return { sent: toSend.length, lineIds: toSend.map((l) => l.id), sentAt: now, tickets };
  });
}

/**
 * Void an item the kitchen already has (pos.void): it leaves the check, and
 * what it used is written off as "prepared, not sold" so it shows as waste.
 */
export async function voidTabLine(ctx: TenantContext, lineId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const line = await tx.posTabLine.findFirst({
      where: { organizationId: ctx.organizationId, id: lineId },
    });
    if (!line) throw notFound("Check item");
    const tab = await loadTab(tx, ctx, line.tabId, true);
    assertPermission(ctx.grants, "pos.void", at(tab.branchId));
    assertOpen(tab);
    if (line.status !== "SENT")
      throw businessRuleViolation(
        "CHECK_ITEM_NOT_SENT",
        "Only items sent to the kitchen are voided; take back an unsent item",
      );
    if (dec(line.paidQuantity).gt(0))
      throw businessRuleViolation("CHECK_ITEM_FIXED", "This item is paid; refund it instead");
    // What the kitchen used, as for a sale; only what stock shows is written off.
    const priced = await priceLinesInTx(tx, ctx, {
      lines: [
        {
          itemId: line.menuItemId,
          quantity: dec(line.quantity).toFixed(),
          optionIds: line.optionIds,
        },
      ],
      channel: tab.channel,
      branchId: tab.branchId,
      date: businessDate(tab.branch.timeZone ?? ctx.timeZone),
      asOf: line.sentAt ?? new Date(),
    }).catch(() => null);
    let wasteDocId: string | null = null;
    if (priced) {
      const use = await explodeUseInTx(tx, ctx, priced.recipeUse, priced.productUse).catch(
        () => null,
      );
      if (use && use.size > 0) {
        const wh = await loadWarehouse(tx, ctx, tab.warehouseId, "pos.void");
        const plan = await planConsumptionInTx(tx, ctx, wh, use, { partial: true });
        if (plan.picks.length > 0)
          wasteDocId = (
            await postConsumptionInTx(
              tx,
              ctx,
              wh,
              plan.picks,
              `${tab.number} #${line.lineNo}: ${parsed.data.reason}`,
              { waste: true },
            )
          ).documentId;
      }
    }
    await tx.posTabLine.update({
      where: { id: line.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: parsed.data.reason,
        wasteDocId,
      },
    });
    await markVoidedInTx(tx, ctx, { tabLineIds: [line.id] });
    await audit(tx, ctx, "pos_tab", tab.id, "item_voided", {
      lineNo: line.lineNo,
      name: line.name,
      quantity: dec(line.quantity).toFixed(),
      reason: parsed.data.reason,
      wasteDocId,
    });
  });
}

/** Move a check to another free table of the same branch. */
export async function moveTab(ctx: TenantContext, tabId: string, rawInput: unknown) {
  const parsed = z.object({ tableId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const tab = await loadTab(tx, ctx, tabId, true);
      assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
      assertOpen(tab);
      const table = await tx.posTable.findFirst({
        where: { organizationId: ctx.organizationId, id: parsed.data.tableId, archivedAt: null },
      });
      if (!table || table.branchId !== tab.branchId) throw notFound("Table");
      await tx.posTab.update({
        where: { id: tab.id },
        data: { tableId: table.id, label: null },
      });
      await audit(tx, ctx, "pos_tab", tab.id, "moved", {
        from: tab.table?.code ?? tab.label,
        to: table.code,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_tabs_one_open_per_table"))
      throw businessRuleViolation("TABLE_HAS_OPEN_CHECK", "That table already has an open check", {
        field: "tableId",
      });
    throw error;
  }
}

/** Merge a check into another of the same branch (tables joined); nothing may be paid yet. */
export async function mergeTabs(ctx: TenantContext, fromTabId: string, rawInput: unknown) {
  const parsed = z.object({ intoTabId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const intoId = parsed.data.intoTabId;
  if (intoId === fromTabId)
    throw businessRuleViolation("CHECK_MERGE_SELF", "Choose another check", {
      field: "intoTabId",
    });
  await withTenantTx(ctx.organizationId, async (tx) => {
    // Lock both in a fixed order so two merges cannot deadlock.
    const [first, second] = [fromTabId, intoId].sort();
    await loadTab(tx, ctx, first, true);
    await loadTab(tx, ctx, second, true);
    const from = await loadTab(tx, ctx, fromTabId);
    const into = await loadTab(tx, ctx, intoId);
    assertPermission(ctx.grants, "pos.tables", at(from.branchId));
    assertOpen(from);
    assertOpen(into);
    if (from.branchId !== into.branchId) throw notFound("Check");
    const paid = await tx.posOrder.count({
      where: { organizationId: ctx.organizationId, tabId: { in: [from.id, into.id] } },
    });
    if (paid > 0)
      throw businessRuleViolation(
        "CHECK_PARTLY_PAID",
        "Part of a check is paid; merge before paying",
      );
    let next = into.lines.reduce((m, l) => Math.max(m, l.lineNo), 0);
    for (const l of from.lines) {
      next += 1;
      await tx.posTabLine.update({ where: { id: l.id }, data: { tabId: into.id, lineNo: next } });
    }
    await tx.posTab.update({
      where: { id: into.id },
      data: { guests: into.guests + from.guests },
    });
    await tx.posTab.update({
      where: { id: from.id },
      data: { status: "MERGED", mergedIntoTabId: into.id, closedAt: new Date() },
    });
    await audit(tx, ctx, "pos_tab", from.id, "merged", { into: into.number });
  });
}

/** Cancel a check nobody paid: its unsent items are dropped; sent items must be voided first. */
export async function cancelTab(ctx: TenantContext, tabId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const tab = await loadTab(tx, ctx, tabId, true);
    assertPermission(ctx.grants, "pos.tables", at(tab.branchId));
    assertOpen(tab);
    if (tab.lines.some((l) => l.status === "SENT"))
      throw businessRuleViolation(
        "CHECK_HAS_SENT_ITEMS",
        "The kitchen has items of this check; void them first",
      );
    if (tab.lines.some((l) => dec(l.paidQuantity).gt(0)))
      throw businessRuleViolation("CHECK_PARTLY_PAID", "Part of this check is paid");
    await tx.posTabLine.deleteMany({
      where: { organizationId: ctx.organizationId, tabId: tab.id, status: "PENDING" },
    });
    await tx.posTab.update({
      where: { id: tab.id },
      // A guest's phone is kept only while the order is open (ADR-070).
      data: {
        status: "CANCELLED",
        cancelReason: parsed.data.reason,
        closedAt: new Date(),
        guestPhone: null,
      },
    });
    await audit(tx, ctx, "pos_tab", tab.id, "cancelled", { reason: parsed.data.reason });
  });
}

const paySchema = z.object({
  /** Generated by the device; a retry returns the same order. */
  orderId: uuidSchema,
  registerId: uuidSchema,
  /** Items and quantities paid now; empty = everything still to pay. */
  lines: z
    .array(
      z.object({
        tabLineId: uuidSchema,
        quantity: decimalString({ maxScale: 3, min: "0.001", max: "999" }),
      }),
    )
    .max(200)
    .default([]),
  payments: orderSchema.shape.payments,
  discount: orderSchema.shape.discount,
  couponCode: orderSchema.shape.couponCode,
  customerId: orderSchema.shape.customerId,
  loyaltyPoints: orderSchema.shape.loyaltyPoints,
  expectedTotal: orderSchema.shape.expectedTotal,
});

/**
 * Pay all or part of a check at a register of the same branch. The paid part
 * becomes an ordinary order (its receipt, stock use, VAT and refunds). Split
 * by items or seats = several payments of parts; split evenly = one order
 * with several payments. The check closes when everything is paid.
 */
export async function payTab(ctx: TenantContext, tabId: string, rawInput: unknown) {
  const parsed = paySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const existing = await tx.posOrder.findFirst({
        where: { organizationId: ctx.organizationId, id: input.orderId },
        select: { id: true, number: true, grossAmount: true, tabId: true },
      });
      if (existing) {
        if (existing.tabId !== tabId)
          throw conflict("This order id is used", { reason: "duplicate" });
        return { id: existing.id, number: existing.number, duplicate: true, closed: false };
      }
      const tab = await loadTab(tx, ctx, tabId, true);
      assertOpen(tab);
      const register = await loadRegister(tx, ctx, input.registerId);
      assertPermission(ctx.grants, "pos.sell", {
        branchId: register.branchId,
        warehouseId: register.warehouseId,
      });
      if (register.branchId !== tab.branchId)
        throw businessRuleViolation(
          "REFUND_OTHER_BRANCH",
          "Pay at a register of the check's branch",
          {
            field: "registerId",
          },
        );
      const wanted =
        input.lines.length > 0
          ? input.lines.map((l) => ({ id: l.tabLineId, quantity: toDecimal(l.quantity) }))
          : tab.lines
              .map((l) => ({
                id: l.id,
                quantity: remainingQuantity({
                  status: l.status,
                  quantity: dec(l.quantity),
                  paidQuantity: dec(l.paidQuantity),
                }),
              }))
              .filter((l) => l.quantity.gt(0));
      if (wanted.length === 0)
        throw businessRuleViolation("NOTHING_TO_PAY", "Nothing is left to pay");
      const chosen = wanted.map((w, index) => {
        const line = tab.lines.find((l) => l.id === w.id);
        if (!line) throw notFound("Check item");
        const left = remainingQuantity({
          status: line.status,
          quantity: dec(line.quantity),
          paidQuantity: dec(line.paidQuantity),
        });
        if (w.quantity.gt(left))
          throw businessRuleViolation("CHECK_ITEM_OVERPAID", "More than is left on this item", {
            field: `lines.${index}.quantity`,
          });
        return { line, quantity: w.quantity };
      });
      if (new Set(chosen.map((c) => c.line.id)).size !== chosen.length)
        throw businessRuleViolation("CHECK_ITEM_OVERPAID", "An item is listed twice");
      const order = orderSchema.safeParse({
        orderId: input.orderId,
        registerId: register.id,
        channel: tab.channel,
        lines: chosen.map((c) => ({
          itemId: c.line.menuItemId,
          quantity: c.quantity.toFixed(),
          optionIds: c.line.optionIds,
        })),
        payments: input.payments,
        discount: input.discount,
        couponCode: input.couponCode,
        customerId: input.customerId,
        loyaltyPoints: input.loyaltyPoints,
        expectedTotal: input.expectedTotal,
      });
      if (!order.success) throw validationFailed(order.error);
      const result = await recordOrderInTx(tx, ctx, order.data, {
        tabId: tab.id,
        warehouseId: tab.warehouseId,
        tabLineIds: chosen.map((c) => c.line.id),
        // Promotions apply as at the time each item was ordered (a happy hour).
        lineTimes: chosen.map((c) => c.line.createdAt),
      });
      for (const c of chosen)
        await tx.posTabLine.update({
          where: { id: c.line.id },
          data: { paidQuantity: dec(c.line.paidQuantity).plus(c.quantity).toFixed() },
        });
      const after = await tx.posTabLine.findMany({
        where: { organizationId: ctx.organizationId, tabId: tab.id },
        select: { status: true, quantity: true, paidQuantity: true },
      });
      const closed = checkSettled(
        after.map((l) => ({
          status: l.status,
          quantity: dec(l.quantity),
          paidQuantity: dec(l.paidQuantity),
        })),
      );
      if (closed)
        await tx.posTab.update({
          where: { id: tab.id },
          data: { status: "CLOSED", closedAt: new Date(), guestPhone: null },
        });
      await audit(tx, ctx, "pos_tab", tab.id, closed ? "paid_closed" : "paid_part", {
        order: result.number,
        lines: chosen.map((c) => ({ lineNo: c.line.lineNo, quantity: c.quantity.toFixed() })),
      });
      return {
        id: result.id,
        number: result.number,
        gross: result.gross,
        change: result.change,
        duplicate: false,
        closed,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_orders_pkey"))
      throw conflict("This order was already recorded", { reason: "duplicate" });
    throw error;
  }
}

/** A check with each item's price now, what is paid, and what the user may do. */
export async function getTab(ctx: TenantContext, tabId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tab = await loadTab(tx, ctx, tabId);
    const date = businessDate(tab.branch.timeZone ?? ctx.timeZone);
    const now = new Date();
    const kitchen = await lineStatusesInTx(tx, ctx, tab.id);
    const promotions = await loadPromotionsInTx(tx, ctx, now);
    const categories = new Map(
      (
        await tx.menuItem.findMany({
          where: {
            organizationId: ctx.organizationId,
            id: { in: tab.lines.map((l) => l.menuItemId) },
          },
          select: { id: true, categoryId: true },
        })
      ).map((i) => [i.id, i.categoryId]),
    );
    const tz = tab.branch.timeZone ?? ctx.timeZone;
    const lines = [];
    for (const l of tab.lines) {
      // Priced one by one so an item withdrawn from the menu shows as a problem, not an error.
      const priced = await priceLinesInTx(tx, ctx, {
        lines: [
          { itemId: l.menuItemId, quantity: dec(l.quantity).toFixed(), optionIds: l.optionIds },
        ],
        channel: tab.channel,
        branchId: tab.branchId,
        date,
        asOf: now,
      }).catch(() => null);
      const line = priced?.lines[0];
      const promotion = promotionFor(
        { id: l.menuItemId, categoryId: categories.get(l.menuItemId) ?? "" },
        saleMoment(tab.channel, tz, l.createdAt),
        promotions,
      );
      const remaining = remainingQuantity({
        status: l.status,
        quantity: dec(l.quantity),
        paidQuantity: dec(l.paidQuantity),
      });
      lines.push({
        ...l,
        quantity: dec(l.quantity),
        paidQuantity: dec(l.paidQuantity),
        remaining,
        unitPrice: line ? dec(line.unitPrice) : null,
        includesTax: line?.priceIncludesTax ?? null,
        taxRate: line?.taxRate ?? null,
        gross: line ? dec(line.grossAmount) : null,
        /** Promotion on this item as ordered (ADR-067); the payment applies it. */
        promotion: promotion
          ? { name: promotion.name, percent: promotion.percent.toFixed() }
          : null,
        kitchen: kitchen.get(l.id) ?? null,
      });
    }
    const orders = await tx.posOrder.findMany({
      where: { organizationId: ctx.organizationId, tabId: tab.id },
      select: { id: true, number: true, grossAmount: true, status: true, orderedAt: true },
      orderBy: { orderedAt: "asc" },
    });
    const otherTabs = await tx.posTab.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: tab.branchId,
        status: "OPEN",
        id: { not: tab.id },
      },
      select: { id: true, number: true, label: true, table: { select: { code: true } } },
      orderBy: { number: "asc" },
    });
    const freeTables = await tx.posTable.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: tab.branchId,
        archivedAt: null,
        tabs: { none: { status: "OPEN" } },
      },
      select: { id: true, code: true },
      orderBy: { code: "asc" },
    });
    const registers = await tx.posRegister.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: tab.branchId,
        archivedAt: null,
        shifts: { some: { status: "OPEN" } },
      },
      select: { id: true, code: true, name: true, warehouseId: true },
      orderBy: { code: "asc" },
    });
    const can = abilities(ctx, tab.branchId);
    return {
      ...tab,
      lines,
      orders,
      otherTabs,
      freeTables,
      registers: registers.filter((r) =>
        hasPermission(ctx.grants, "pos.sell", {
          branchId: tab.branchId,
          warehouseId: r.warehouseId,
        }),
      ),
      currency: ctx.baseCurrency,
      cashierUserId: ctx.userId,
      can: { ...can, open: tab.status === "OPEN" },
    };
  });
}

export type TabView = Awaited<ReturnType<typeof getTab>>;
