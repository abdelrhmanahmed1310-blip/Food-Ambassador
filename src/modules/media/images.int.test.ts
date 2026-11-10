import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBarcode, createProduct, listUnits } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import {
  addMenuItemPrice,
  createMenuCategory,
  createMenuItem,
  getMenuItem,
  updateMenuCategory,
  updateMenuItem,
} from "@/modules/menu/service";
import { createOrderingChannel, placeGuestOrder, publicMenu } from "@/modules/pos/ordering";
import { sellableMenu } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addExtraPhoto,
  imageForServing,
  processImage,
  removeExtraPhoto,
  setMenuItemImage,
  setProductImage,
} from "./images";

/** Product and menu item photos, menu item barcodes (ADR-133). */

let ctx: TenantContext;
let analyst: TenantContext;
let branch: string;
let water: string;
let category: string;

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .png()
    .toBuffer();

beforeAll(async () => {
  ({ ctx } = await createTenant("photos"));
  analyst = (await addMember(ctx, "analyst", {}, "photos-analyst")).ctx;
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branch = (await createBranch(ctx, { code: "MAIN", name: "Main", type: "RESTAURANT" })).id;
  water = (
    await createProduct(ctx, {
      sku: "WATER",
      nameEn: "Water bottle",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  await addBarcode(ctx, water, { barcode: "6281000000014", symbology: "EAN13" });
  category = (await createMenuCategory(ctx, { name: "Drinks" })).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("photo processing (ADR-133)", () => {
  it("re-encodes to WebP, at most 1200 px, without metadata", async () => {
    const input = await sharp(await png(3000, 1500))
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "camera data" } } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processImage(input);
    const meta = await sharp(out.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 1200, 600]);
    expect(meta.exif).toBeUndefined();
    expect([out.width, out.height]).toEqual([1200, 600]);
    // A small photo is not enlarged.
    const small = await processImage(await png(300, 200));
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it("refuses what is not a photo, by its content", async () => {
    await expectAppError(
      processImage(new TextEncoder().encode("<svg onload=alert(1)>")),
      "BUSINESS_RULE_VIOLATION",
    );
    // An SVG is an image format sharp reads, but not one accepted here.
    await expectAppError(
      processImage(
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
      ),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(processImage(new Uint8Array()), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      processImage(new Uint8Array(5 * 1024 * 1024 + 1)),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("product and menu item photos (ADR-133)", () => {
  it("sets, replaces and removes a product photo; old photos are deleted", async () => {
    await expectAppError(setProductImage(analyst, water, await png(400, 300)), "FORBIDDEN");
    const first = await setProductImage(ctx, water, await png(400, 300));
    const served = await imageForServing(first.imageId!);
    expect(served?.contentType).toBe("image/webp");
    expect((await sharp(Buffer.from(served!.data)).metadata()).format).toBe("webp");
    const second = await setProductImage(ctx, water, await png(500, 300));
    expect(second.imageId).not.toBe(first.imageId);
    expect(await imageForServing(first.imageId!)).toBeNull();
    // Another organization cannot set it.
    const other = (await createTenant("photos-other")).ctx;
    await expectAppError(setProductImage(other, water, await png(10, 10)), "NOT_FOUND");
    expect(await imageForServing("not-a-uuid")).toBeNull();
  });

  it("shows an item's own photo, else its product's, with its barcodes, on the till menu", async () => {
    const item = await createMenuItem(ctx, {
      code: "water",
      name: "Water",
      categoryId: category,
      kind: "ITEM",
      productId: water,
      barcode: "SKU-WATER",
    });
    await addMenuItemPrice(ctx, item!.id, {
      channel: "TAKEAWAY",
      price: "2",
      effectiveFrom: addDays(businessDate(ctx.timeZone), -1),
    });
    const productImage = (await getDb().product.findUniqueOrThrow({ where: { id: water } }))
      .imageId;
    const onTill = async () =>
      (await sellableMenu(ctx, branch, businessDate(ctx.timeZone)))
        .find((c) => c.channel === "TAKEAWAY")!
        .items.find((i) => i.id === item!.id)!;
    expect(await onTill()).toMatchObject({
      imageUrl: `/media/${productImage}`,
      barcodes: ["SKU-WATER", "6281000000014"],
    });
    const own = await setMenuItemImage(ctx, item!.id, await png(300, 300));
    expect((await onTill()).imageUrl).toBe(`/media/${own.imageId}`);
    await setMenuItemImage(ctx, item!.id, null);
    expect((await onTill()).imageUrl).toBe(`/media/${productImage}`);
    // The product photo is still used by the product, so it was not deleted.
    expect(await imageForServing(productImage!)).not.toBeNull();
    expect(await imageForServing(own.imageId!)).toBeNull();
  });

  it("keeps barcodes unambiguous: one item per code, never another product's code", async () => {
    const make = (code: string, barcode: string, productId?: string) =>
      createMenuItem(ctx, {
        code,
        name: code,
        categoryId: category,
        kind: "ITEM",
        ...(productId ? { productId } : { productId: water }),
        barcode,
      });
    await expectAppError(make("water2", "SKU-WATER"), "CONFLICT");
    const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
    const juice = (
      await createProduct(ctx, {
        sku: "JUICE",
        nameEn: "Juice",
        type: "FINISHED_GOOD",
        baseUomId: units.each,
      })
    ).id;
    // The water bottle's barcode cannot name a juice item.
    await expectAppError(make("juice", "6281000000014", juice), "BUSINESS_RULE_VIOLATION");
    // A wrong check digit is refused; a Code 128 label is fine.
    await expectAppError(make("juice", "6281000000015", juice), "VALIDATION_FAILED");
    const ok = await make("juice", "JUICE-330", juice);
    const detail = await getMenuItem(ctx, ok!.id);
    expect(detail.barcode).toBe("JUICE-330");
    // Clearing it leaves none.
    await updateMenuItem(ctx, ok!.id, {
      code: "juice",
      name: "juice",
      categoryId: category,
      kind: "ITEM",
      productId: juice,
      barcode: "",
    });
    expect((await getMenuItem(ctx, ok!.id)).barcode).toBeNull();
  });

  it("shows the menu with photos on a menu board, which takes no orders", async () => {
    const board = await createOrderingChannel(ctx, {
      kind: "BOARD",
      name: "Front screen",
      branchId: branch,
      channels: ["TAKEAWAY"],
    });
    const menu = await publicMenu(board.publicToken);
    expect(menu?.kind).toBe("BOARD");
    const item = menu!.channels[0].items.find((i) => i.name === "Water")!;
    expect(item.imageUrl).toMatch(/^\/media\//);
    await expectAppError(
      placeGuestOrder(
        board.publicToken,
        {
          key: crypto.randomUUID(),
          channel: "TAKEAWAY",
          name: "Guest",
          lines: [{ itemId: item.id, quantity: 1 }],
        },
        "10.0.0.1",
      ),
      "NOT_FOUND",
    );
  });

  it("adds up to four more photos, main photo first; the item's own set replaces the product's", async () => {
    const water = (
      await getDb().product.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, sku: "WATER" },
      })
    ).id;
    const item = (
      await getDb().menuItem.findFirstOrThrow({
        where: {
          organizationId: ctx.organizationId,
          code: { equals: "water", mode: "insensitive" },
        },
      })
    ).id;
    await expectAppError(
      addExtraPhoto(analyst, { productId: water }, await png(50, 50)),
      "FORBIDDEN",
    );
    const added = [];
    for (let i = 0; i < 4; i++)
      added.push(await addExtraPhoto(ctx, { productId: water }, await png(60 + i, 60)));
    await expectAppError(
      addExtraPhoto(ctx, { productId: water }, await png(70, 60)),
      "BUSINESS_RULE_VIOLATION",
    );
    const photosOnTill = async () =>
      (await sellableMenu(ctx, branch, businessDate(ctx.timeZone)))
        .find((c) => c.channel === "TAKEAWAY")!
        .items.find((i) => i.id === item)!.photos;
    const main = (await getDb().product.findUniqueOrThrow({ where: { id: water } })).imageId;
    expect(await photosOnTill()).toEqual([
      `/media/${main}`,
      ...added.map((a) => `/media/${a.imageId}`),
    ]);
    // An extra photo on the item itself: the item's set is used, not the product's.
    const own = await addExtraPhoto(ctx, { menuItemId: item }, await png(80, 60));
    expect(await photosOnTill()).toEqual([`/media/${own.imageId}`]);
    await removeExtraPhoto(ctx, own.id);
    expect(await imageForServing(own.imageId)).toBeNull();
    expect((await photosOnTill())[0]).toBe(`/media/${main}`);
    await expectAppError(removeExtraPhoto(analyst, added[0].id), "FORBIDDEN");
    const other = (await createTenant("photos-extra-other")).ctx;
    await expectAppError(removeExtraPhoto(other, added[0].id), "NOT_FOUND");
  });

  it("keeps board hours on categories whole, and board options on the channel", async () => {
    await expectAppError(
      updateMenuCategory(ctx, category, { name: "Drinks", boardFrom: "06:00" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      updateMenuCategory(ctx, category, { name: "Drinks", boardFrom: "06:00", boardTo: "06:00" }),
      "VALIDATION_FAILED",
    );
    await updateMenuCategory(ctx, category, {
      name: "Drinks",
      boardFrom: "06:00",
      boardTo: "11:00",
    });
    const board = await createOrderingChannel(ctx, {
      kind: "BOARD",
      name: "Dark screen",
      branchId: branch,
      channels: ["TAKEAWAY"],
      boardTheme: "DARK",
      boardPageSeconds: "12",
    });
    const menu = (await publicMenu(board.publicToken))!;
    expect([menu.boardTheme, menu.boardPageSeconds]).toEqual(["DARK", 12]);
    expect(menu.channels[0].items[0].category).toMatchObject({
      boardFrom: "06:00",
      boardTo: "11:00",
    });
    await expectAppError(
      createOrderingChannel(ctx, {
        kind: "BOARD",
        name: "x",
        branchId: branch,
        channels: ["TAKEAWAY"],
        boardPageSeconds: "3",
      }),
      "VALIDATION_FAILED",
    );
    await updateMenuCategory(ctx, category, { name: "Drinks", boardFrom: "", boardTo: "" });
  });
});
