import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "@/modules/api/clients";
import { createMenuCategory } from "@/modules/menu/service";
import { createOrderingChannel, publicMenu } from "@/modules/pos/ordering";
import { createBranch } from "@/modules/sites/branches";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";
import { apiRoute } from "@/server/routes/api-route";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { featureOn, pathEnabled } from "./access";
import { getFeatureSettings, organizationFeatureOn, saveFeatureSettings } from "./service";

/** Settings → Modules: switching modules and functions off (ADR-137). */

let ctx: TenantContext;

/** The form as Settings → Modules sends it, everything on except `off`. */
async function form(off: string[] = []) {
  const values: Record<string, string> = {};
  for (const m of await getFeatureSettings(ctx)) {
    if (!off.includes(`module:${m.key}`)) values[`module:${m.key}`] = "on";
    for (const f of m.features) if (!off.includes(f.key)) values[`feature:${f.key}`] = "on";
  }
  return values;
}
const fresh = async () =>
  (await withSystemTx((tx) => resolveTenantContext(tx, ctx.userId, ctx.organizationSlug)))!;

beforeAll(async () => {
  ({ ctx } = await createTenant("features"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("module and function switches (ADR-137)", () => {
  it("starts with everything on and saves module and function switches, with an audit entry", async () => {
    const settings = await getFeatureSettings(ctx);
    expect(settings.every((m) => m.on && m.features.every((f) => f.on))).toBe(true);
    expect(await saveFeatureSettings(ctx, await form())).toEqual({
      switchedOff: [],
      switchedOn: [],
    });

    const r = await saveFeatureSettings(ctx, await form(["module:hr", "pos.simulator"]));
    expect(r.switchedOff).toEqual(["module:hr", "pos.simulator"]);
    const now = await fresh();
    expect(now.disabledFeatures).toEqual(["module:hr", "pos.simulator"]);
    expect(featureOn(now, "hr.payroll")).toBe(false);
    expect(featureOn(now, "pos.till")).toBe(true);
    const slug = ctx.organizationSlug;
    expect(pathEnabled(now, slug, `/o/${slug}/hr/payroll/run-1`)).toBe(false);
    expect(pathEnabled(now, slug, `/o/${slug}/my/payslips`)).toBe(false);
    expect(pathEnabled(now, slug, `/o/${slug}/pos/simulator`)).toBe(false);
    expect(pathEnabled(now, slug, `/o/${slug}/pos`)).toBe(true);
    expect(pathEnabled(now, slug, `/o/${slug}`)).toBe(true);
    expect(pathEnabled(now, slug, `/o/${slug}/settings/modules`)).toBe(true);
    expect(pathEnabled(now, slug, `/o/other-org/hr`)).toBe(true);
    const audit = await getDb().auditEvent.findFirst({
      where: { organizationId: ctx.organizationId, action: "organization.features_changed" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit?.changes).toMatchObject({ switchedOff: ["module:hr", "pos.simulator"] });
    // A switched-off module keeps its functions' own switches for when it comes back.
    const hr = (await getFeatureSettings(ctx)).find((m) => m.key === "hr")!;
    expect([hr.on, hr.features[0].on, hr.features[0].effective]).toEqual([false, true, false]);
  });

  it("refuses to leave a function on without what it needs; core functions stay on", async () => {
    await expectAppError(
      saveFeatureSettings(ctx, await form(["kitchen.menu"])),
      "BUSINESS_RULE_VIOLATION",
    );
    const err = await saveFeatureSettings(ctx, await form(["kitchen.recipes"])).catch((e) => e);
    expect(err.details.pairs).toContain("kitchen.foodCost>kitchen.recipes");
    // A core function sent as off is kept on.
    await saveFeatureSettings(ctx, await form(["catalog.products", "settings.organization"]));
    const now = await fresh();
    expect(now.disabledFeatures).toEqual([]);
    expect(featureOn(now, "catalog.products")).toBe(true);
  });

  it("is for organization settings managers only, and per organization", async () => {
    const analyst = (await addMember(ctx, "analyst", {}, "features-analyst")).ctx;
    await expectAppError(getFeatureSettings(analyst), "FORBIDDEN");
    await expectAppError(saveFeatureSettings(analyst, {}), "FORBIDDEN");
    const other = (await createTenant("features-other")).ctx;
    await saveFeatureSettings(ctx, await form(["module:b2b"]));
    expect(await organizationFeatureOn(ctx.organizationId, "b2b.orders")).toBe(false);
    expect(await organizationFeatureOn(other.organizationId, "b2b.orders")).toBe(true);
    await saveFeatureSettings(ctx, await form());
  });

  it("stops the REST API, or one of its resources, when switched off", async () => {
    const key = (await createApiClient(ctx, { name: "BI", scopes: ["products:read"] })).key;
    const call = async (path: string) => {
      const res = await apiRoute(
        new Request(`http://localhost/api/v1/${path}`, {
          headers: { authorization: `Bearer ${key}` },
        }),
        async () => ({ ok: true }),
      );
      return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
    };
    expect((await call("products")).status).toBe(200);
    await saveFeatureSettings(ctx, await form(["catalog.nutrition"]));
    expect(await call("nutrition/foods")).toMatchObject({
      status: 404,
      body: { error: { code: "FEATURE_DISABLED" } },
    });
    expect((await call("products")).status).toBe(200);
    await saveFeatureSettings(ctx, await form(["settings.api"]));
    expect((await call("products")).status).toBe(404);
    await saveFeatureSettings(ctx, await form());
    expect((await call("products")).status).toBe(200);
  });

  it("closes online ordering, kiosk and menu board links when switched off", async () => {
    const branchId = (await createBranch(ctx, { code: "MAIN", name: "Main", type: "RESTAURANT" }))
      .id;
    await createMenuCategory(ctx, { name: "Drinks" });
    const board = await createOrderingChannel(ctx, {
      kind: "BOARD",
      name: "Screen",
      branchId,
      channels: ["TAKEAWAY"],
    });
    expect(await publicMenu(board.publicToken)).not.toBeNull();
    await saveFeatureSettings(ctx, await form(["pos.online"]));
    expect(await publicMenu(board.publicToken)).toBeNull();
    await saveFeatureSettings(ctx, await form());
    expect(await publicMenu(board.publicToken)).not.toBeNull();
  });
});
