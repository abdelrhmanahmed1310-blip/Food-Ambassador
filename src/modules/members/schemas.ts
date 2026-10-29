import { z } from "zod";
import { emailSchema, optionalUuidSchema, uuidSchema } from "@/modules/shared/schemas";

/** Role + scope pair used by invitations and role grants. */
export const roleScopeSchema = z
  .object({
    roleId: uuidSchema,
    scopeType: z
      .enum(["ORGANIZATION", "BRANCH", "WAREHOUSE"], { error: "invalidOption" })
      .default("ORGANIZATION"),
    branchId: optionalUuidSchema,
    warehouseId: optionalUuidSchema,
  })
  .transform((v) => ({
    roleId: v.roleId,
    scopeType: v.scopeType,
    branchId: v.scopeType === "BRANCH" ? v.branchId : undefined,
    warehouseId: v.scopeType === "WAREHOUSE" ? v.warehouseId : undefined,
  }))
  .superRefine((v, ctx) => {
    if (v.scopeType === "BRANCH" && !v.branchId)
      ctx.addIssue({ code: "custom", path: ["branchId"], message: "required" });
    if (v.scopeType === "WAREHOUSE" && !v.warehouseId)
      ctx.addIssue({ code: "custom", path: ["warehouseId"], message: "required" });
  });
export type RoleScopeInput = z.input<typeof roleScopeSchema>;

export const inviteSchema = z.intersection(z.object({ email: emailSchema }), roleScopeSchema);
