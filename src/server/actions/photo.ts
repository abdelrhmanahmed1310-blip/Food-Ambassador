import "server-only";
import { MAX_UPLOAD_BYTES } from "@/modules/media/images";
import { businessRuleViolation } from "@/server/errors";

/** The uploaded photo's bytes from a form (field "photo"); the image service checks the content. */
export async function photoFrom(formData: FormData): Promise<Uint8Array> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0)
    throw businessRuleViolation("IMAGE_INVALID", "Choose a photo", { field: "photo" });
  if (file.size > MAX_UPLOAD_BYTES)
    throw businessRuleViolation("IMAGE_TOO_LARGE", "A photo can be at most 5 MB", {
      field: "photo",
    });
  return new Uint8Array(await file.arrayBuffer());
}
