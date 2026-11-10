import { imageForServing } from "@/modules/media/images";

/**
 * A product or menu item photo (ADR-133). Public, for the ordering page,
 * kiosks and menu boards; a photo never changes under its id, so browsers
 * and screens may keep it.
 */
export async function GET(_request: Request, { params }: RouteContext<"/media/[imageId]">) {
  const { imageId } = await params;
  const image = await imageForServing(imageId);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${image.sha256}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
