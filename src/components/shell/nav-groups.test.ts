import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeTab, groupNav, NAV_SECTIONS, SETTINGS_CARDS } from "./nav-groups";

/** The menu grouped by process (ADR-139). */

const base = "/o/acme";
const LINKS = readFileSync(join(process.cwd(), "src/server/navigation.ts"), "utf8");
const offered = ["", ...[...LINKS.matchAll(/href: `\$\{base\}\/([^`]+)`/g)].map((m) => m[1])];
const grouped = NAV_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.paths));

describe("process groups (ADR-139)", () => {
  it("puts every link the app offers in exactly one group", () => {
    expect(offered.length).toBeGreaterThan(130);
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const p of offered) expect(grouped, p).toContain(p);
    for (const p of grouped) expect(offered, p).toContain(p);
    // Settings cards list exactly the settings group's links.
    const settings = NAV_SECTIONS.flatMap((s) => s.groups).find((g) => g.key === "settings")!;
    expect(SETTINGS_CARDS.flatMap((c) => c.paths).sort()).toEqual([...settings.paths].sort());
  });

  it("cuts the menu to about forty links", () => {
    const all = offered.map((p) => ({
      href: p ? `${base}/${p}` : base,
      label: p,
      exact: p === "",
    }));
    const { sections, ungrouped } = groupNav(all, base, (k) => k);
    expect(ungrouped).toEqual([]);
    const count = sections.reduce((n, s) => n + s.items.length, 0);
    expect(count).toBeLessThanOrEqual(42);
    expect(sections.map((s) => s.title)).toEqual([
      undefined,
      "sell",
      "kitchen",
      "procureToPay",
      "stock",
      "b2b",
      "finance",
      "safety",
      "people",
      "insights",
      "catalog",
      "settingsSection",
    ]);
  });

  it("shows only what a person has, linking a group to its first page or its hub", () => {
    const links = [
      { href: `${base}/purchasing/orders`, label: "Purchase orders" },
      { href: `${base}/purchasing/reorder`, label: "Reorder" },
      { href: `${base}/settings/members`, label: "Members" },
    ];
    const { sections, tabs } = groupNav(links, base, (k) => k);
    expect(sections.map((s) => [s.title, s.items.map((i) => [i.label, i.href])])).toEqual([
      ["procureToPay", [["buying", `${base}/purchasing/orders`]]],
      ["settingsSection", [["settings", `${base}/settings`]]],
    ]);
    // A purchase order's page sits in Buying, with its tabs; settings pages go back to the hub.
    expect(activeTab(`${base}/purchasing/orders/123`, tabs)).toMatchObject({
      group: { key: "buying" },
      link: { href: `${base}/purchasing/orders` },
    });
    expect(activeTab(`${base}/settings`, tabs)).toMatchObject({
      group: { key: "settings" },
      link: null,
    });
    expect(activeTab(`${base}/settings/members`, tabs)?.group.hub).toBe(`${base}/settings`);
    expect(activeTab(`${base}/notifications`, tabs)).toBeNull();
  });

  it("picks the longest address: the floor plan, not the till; the overview only exactly", () => {
    const links = [
      { href: base, label: "Overview", exact: true },
      { href: `${base}/pos`, label: "Point of sale" },
      { href: `${base}/pos/floor`, label: "Floor plan" },
      { href: `${base}/pos/settlements`, label: "Settlements" },
    ];
    const { tabs } = groupNav(links, base, (k) => k);
    expect(activeTab(`${base}/pos/floor/2`, tabs)?.link?.label).toBe("Floor plan");
    expect(activeTab(`${base}/pos/registers/1`, tabs)?.link?.label).toBe("Point of sale");
    expect(activeTab(`${base}/pos/settlements`, tabs)?.group.key).toBe("taxSettlements");
    expect(activeTab(`${base}/search`, tabs)).toBeNull();
  });
});
