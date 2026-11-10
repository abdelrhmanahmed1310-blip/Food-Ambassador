import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound } from "@/server/errors";

/**
 * Photos of products and menu items (DECISIONS.md ADR-133), shown on the
 * till, kiosk, online ordering page and menu boards. An upload is decoded
 * and re-encoded: only JPEG, PNG or WebP is accepted (by its content, not
 * its name), it is turned upright, scaled to at most 1200 px a side and
 * saved as WebP without metadata (no camera or location data). What is
 * served is always an image this code produced.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 1200;
const ACCEPTED = new Set(["jpeg", "png", "webp"]);

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
}

/** Decode, check and re-encode an upload. Throws IMAGE_INVALID / IMAGE_TOO_LARGE. */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
  if (input.byteLength === 0)
    throw businessRuleViolation("IMAGE_INVALID", "Choose a photo", { field: "photo" });
  if (input.byteLength > MAX_UPLOAD_BYTES)
    throw businessRuleViolation("IMAGE_TOO_LARGE", "A photo can be at most 5 MB", {
      field: "photo",
    });
  let format: string | undefined;
  try {
    // limitInputPixels guards against decompression bombs (e.g. a tiny file claiming 50,000 px).
    format = (await sharp(input, { limitInputPixels: 40_000_000 }).metadata()).format;
  } catch {
    format = undefined;
  }
  if (!format || !ACCEPTED.has(format))
    throw businessRuleViolation("IMAGE_INVALID", "Upload a JPEG, PNG or WebP photo", {
      field: "photo",
    });
  try {
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch {
    throw businessRuleViolation("IMAGE_INVALID", "The photo could not be read", {
      field: "photo",
    });
  }
}

async function storeInTx(tx: Tx, ctx: TenantContext, img: ProcessedImage) {
  return tx.mediaImage.create({
    data: {
      organizationId: ctx.organizationId,
      contentType: "image/webp",
      width: img.width,
      height: img.height,
      sizeBytes: img.data.byteLength,
      sha256: img.sha256,
      data: new Uint8Array(img.data),
      uploadedByUserId: ctx.userId,
    },
    select: { id: true },
  });
}

/** Delete an image no product or menu item uses any more. */
async function dropIfUnusedInTx(tx: Tx, ctx: TenantContext, imageId: string | null) {
  if (!imageId) return;
  const [p, m, x] = await Promise.all([
    tx.product.count({ where: { organizationId: ctx.organizationId, imageId } }),
    tx.menuItem.count({ where: { organizationId: ctx.organizationId, imageId } }),
    tx.itemPhoto.count({ where: { organizationId: ctx.organizationId, imageId } }),
  ]);
  if (p + m + x === 0)
    await tx.mediaImage.deleteMany({ where: { organizationId: ctx.organizationId, id: imageId } });
}

/** Replace (a file) or remove (null) a product's photo. Needs catalog.manage. */
export async function setProductImage(
  ctx: TenantContext,
  productId: string,
  upload: Uint8Array | null,
) {
  assertPermission(ctx.grants, "catalog.manage");
  const img = upload ? await processImage(upload) : null;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: productId },
      select: { id: true, imageId: true },
    });
    if (!product) throw notFound("Product");
    const created = img ? await storeInTx(tx, ctx, img) : null;
    await tx.product.update({
      where: { id: product.id },
      data: { imageId: created?.id ?? null, updatedByUserId: ctx.userId },
    });
    await dropIfUnusedInTx(tx, ctx, product.imageId);
    await recordAudit(tx, actorOf(ctx), {
      action: created ? "product.photo_set" : "product.photo_removed",
      entityType: "product",
      entityId: product.id,
      changes: created ? { width: img!.width, height: img!.height } : {},
    });
    return { imageId: created?.id ?? null };
  });
}

/** Replace (a file) or remove (null) a menu item's own photo. Needs menu.manage. */
export async function setMenuItemImage(
  ctx: TenantContext,
  itemId: string,
  upload: Uint8Array | null,
) {
  assertPermission(ctx.grants, "menu.manage");
  const img = upload ? await processImage(upload) : null;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const item = await tx.menuItem.findFirst({
      where: { organizationId: ctx.organizationId, id: itemId },
      select: { id: true, imageId: true },
    });
    if (!item) throw notFound("Menu item");
    const created = img ? await storeInTx(tx, ctx, img) : null;
    await tx.menuItem.update({ where: { id: item.id }, data: { imageId: created?.id ?? null } });
    await dropIfUnusedInTx(tx, ctx, item.imageId);
    await recordAudit(tx, actorOf(ctx), {
      action: created ? "menu_item.photo_set" : "menu_item.photo_removed",
      entityType: "menu_item",
      entityId: item.id,
      changes: created ? { width: img!.width, height: img!.height } : {},
    });
    return { imageId: created?.id ?? null };
  });
}

export const MAX_EXTRA_PHOTOS = 4;

type Owner = { productId: string } | { menuItemId: string };

/**
 * Add one more photo to a product or menu item, after its main photo (at most
 * four). Menu boards show them in turn; the main photo stays the first.
 */
export async function addExtraPhoto(ctx: TenantContext, owner: Owner, upload: Uint8Array) {
  const isProduct = "productId" in owner;
  assertPermission(ctx.grants, isProduct ? "catalog.manage" : "menu.manage");
  const img = await processImage(upload);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const exists = isProduct
      ? await tx.product.findFirst({ where: { organizationId: org, id: owner.productId } })
      : await tx.menuItem.findFirst({ where: { organizationId: org, id: owner.menuItemId } });
    if (!exists) throw notFound(isProduct ? "Product" : "Menu item");
    const where = isProduct
      ? { organizationId: org, productId: owner.productId }
      : { organizationId: org, menuItemId: owner.menuItemId };
    const count = await tx.itemPhoto.count({ where });
    if (count >= MAX_EXTRA_PHOTOS)
      throw businessRuleViolation("TOO_MANY_PHOTOS", "At most four more photos", {
        field: "photo",
        max: MAX_EXTRA_PHOTOS,
      });
    const created = await storeInTx(tx, ctx, img);
    const photo = await tx.itemPhoto.create({
      data: { ...where, imageId: created.id, sortOrder: count + 1 },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: isProduct ? "product.photo_added" : "menu_item.photo_added",
      entityType: isProduct ? "product" : "menu_item",
      entityId: exists.id,
      changes: { photoId: photo.id },
    });
    return { id: photo.id, imageId: created.id };
  });
}

export async function removeExtraPhoto(ctx: TenantContext, photoId: string) {
  const id = uuidSchema.safeParse(photoId);
  if (!id.success) throw notFound("Photo");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const photo = await tx.itemPhoto.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!photo) throw notFound("Photo");
    assertPermission(ctx.grants, photo.productId ? "catalog.manage" : "menu.manage");
    await tx.itemPhoto.delete({ where: { id: photo.id } });
    await dropIfUnusedInTx(tx, ctx, photo.imageId);
    await recordAudit(tx, actorOf(ctx), {
      action: photo.productId ? "product.photo_removed" : "menu_item.photo_removed",
      entityType: photo.productId ? "product" : "menu_item",
      entityId: (photo.productId ?? photo.menuItemId)!,
      changes: { photoId: photo.id },
    });
  });
}

/** Extra photos of products and menu items, in order. */
export async function listExtraPhotos(ctx: TenantContext, owner: Owner) {
  assertPermission(ctx.grants, "productId" in owner ? "catalog.view" : "menu.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.itemPhoto.findMany({
      where:
        "productId" in owner
          ? { organizationId: ctx.organizationId, productId: owner.productId }
          : { organizationId: ctx.organizationId, menuItemId: owner.menuItemId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, imageId: true },
    }),
  );
}

/**
 * The bytes of a photo, by id, for /media/{id}. Photos are shown on public
 * pages (online ordering, kiosks, menu boards), so they are read without a
 * session; ids are random UUIDs and nothing but the photo is returned.
 */
export async function imageForServing(imageId: string) {
  const id = uuidSchema.safeParse(imageId);
  if (!id.success) return null;
  return withSystemTx((tx) =>
    tx.mediaImage.findUnique({
      where: { id: id.data },
      select: { data: true, contentType: true, sha256: true },
    }),
  );
}

/** The URL of a photo (stable: a new photo gets a new id). */
export const imageUrl = (imageId: string | null | undefined) =>
  imageId ? `/media/${imageId}` : null;
