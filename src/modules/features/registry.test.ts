import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanEntries,
  dependencyProblems,
  FEATURE_KEYS,
  FEATURES,
  featureForApi,
  featureForPath,
  isFeatureOn,
  moduleEntry,
  MODULES,
} from "./registry";

/** Module and function switches (ADR-137). */

const ORG_APP = join(process.cwd(), "src/app/o/[orgSlug]");
/** Pages no function claims: always on. */
const ALWAYS_ON = new Set(["attachments", "notifications", "search"]);

describe("feature registry (ADR-137)", () => {
  it("is consistent: unique keys and prefixes, known requirements", () => {
    expect(FEATURE_KEYS.size).toBe(FEATURES.length);
    const prefixes = FEATURES.flatMap((f) => f.paths);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const m of MODULES)
      for (const r of [...(m.requires ?? []), ...m.features.flatMap((f) => f.requires ?? [])])
        expect(FEATURE_KEYS.has(r), r).toBe(true);
    // A core function never needs a switchable one, or it could be left without it.
    for (const f of FEATURES.filter((x) => x.core))
      for (const r of f.requires ?? []) expect(FEATURES.find((x) => x.key === r)?.core).toBe(true);
    // With nothing switched off, nothing is missing.
    expect(dependencyProblems(new Set())).toEqual([]);
  });

  it("finds a page's function by its longest prefix, on whole path segments", () => {
    expect(featureForPath("/pos")).toBe("pos.till");
    expect(featureForPath("/pos/registers/abc")).toBe("pos.till");
    expect(featureForPath("/pos/kitchen")).toBe("pos.kitchen");
    expect(featureForPath("/pos/customers/campaigns/1")).toBe("pos.crm");
    expect(featureForPath("/pos/customers/123")).toBe("pos.customers");
    expect(featureForPath("/recipes/food-cost")).toBe("kitchen.foodCost");
    expect(featureForPath("/recipes/0190")).toBe("kitchen.recipes");
    expect(featureForPath("/settings/modules")).toBe("settings.organization");
    expect(featureForPath("/settings/zatca")).toBe("settings.zatca");
    expect(featureForPath("/my/payslips/2026-10")).toBe("hr.payroll");
    // "posx" is not under "pos"; the dashboard belongs to no function.
    expect(featureForPath("/posx")).toBeNull();
    expect(featureForPath("")).toBeNull();
    expect(featureForPath("/notifications")).toBeNull();
    expect(featureForApi("purchase-orders")).toBe("purchasing.orders");
    expect(featureForApi("openapi.json")).toBeNull();
  });

  it("claims every menu link and every page area", () => {
    const layout = readFileSync(join(process.cwd(), "src/server/navigation.ts"), "utf8");
    const hrefs = [...layout.matchAll(/href: `\$\{base\}\/([^`]+)`/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(80);
    for (const h of hrefs) expect(featureForPath(h), h).not.toBeNull();
    // Every page under the organization (dynamic segments included) belongs to a function.
    const pages: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (rel === "" && ALWAYS_ON.has(e.name)) continue;
          walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        } else if (e.name === "page.tsx" && rel) pages.push(rel);
      }
    };
    walk(ORG_APP, "");
    expect(pages.length).toBeGreaterThan(150);
    for (const p of pages) expect(featureForPath(p), p).not.toBeNull();
  });

  it("turns a module off with its functions; core functions stay on", () => {
    const off = new Set([moduleEntry("hr")]);
    expect(isFeatureOn("hr.payroll", off)).toBe(false);
    expect(isFeatureOn("pos.till", off)).toBe(true);
    expect(
      isFeatureOn("catalog.products", new Set([moduleEntry("catalog"), "catalog.products"])),
    ).toBe(true);
    expect(isFeatureOn("hr.payroll", new Set(["hr.payroll"]))).toBe(false);
    expect(isFeatureOn("unknown.key", off)).toBe(true);
  });

  it("reports what a function that stays on needs", () => {
    expect(dependencyProblems(new Set(["kitchen.recipes"]))).toEqual(
      expect.arrayContaining([
        ["kitchen.foodCost", "kitchen.recipes"],
        ["kitchen.production", "kitchen.recipes"],
      ]),
    );
    // The POS module needs the menu.
    expect(dependencyProblems(new Set(["kitchen.menu"]))).toContainEqual([
      "pos.till",
      "kitchen.menu",
    ]);
    // Switching the POS off too resolves it.
    expect(
      dependencyProblems(new Set(["kitchen.menu", moduleEntry("pos"), "reports.kitchen"])),
    ).toEqual([]);
  });

  it("keeps only known modules and switchable functions", () => {
    expect(
      cleanEntries([
        "hr.payroll",
        "catalog.products",
        "module:nope",
        "nope.x",
        "module:hr",
        "module:hr",
      ]),
    ).toEqual(["hr.payroll", "module:hr"]);
  });
});
