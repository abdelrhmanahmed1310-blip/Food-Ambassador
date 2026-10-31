import { afterAll, describe, expect, it } from "vitest";
import { listRoles } from "@/modules/access/roles";
import { getOrganizationSettings } from "@/modules/organizations/service";
import { getTaxSetup } from "@/modules/tax/service";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";

// Found in the M8c security review: these reads relied on page checks only.
afterAll(async () => {
  await getDb().$disconnect();
});

describe("service-level checks on settings reads", () => {
  it("refuses roles, VAT setup and organization settings to a read-only analyst", async () => {
    const { ctx } = await createTenant("guards");
    const analyst = (await addMember(ctx, "analyst")).ctx;
    await expectAppError(listRoles(analyst), "FORBIDDEN");
    await expectAppError(getTaxSetup(analyst), "FORBIDDEN");
    await expectAppError(getOrganizationSettings(analyst), "FORBIDDEN");
    // Those who use them still can.
    expect((await listRoles(ctx)).length).toBeGreaterThan(0);
    const chef = (await addMember(ctx, "operations_manager")).ctx;
    expect((await getTaxSetup(chef)).codes).toEqual([]);
    expect((await getOrganizationSettings(ctx)).id).toBe(ctx.organizationId);
  });
});
