import { describe, expect, it } from "vitest";
import ar from "./messages/ar.json";
import en from "./messages/en.json";
import { PERMISSIONS, SYSTEM_ROLE_TEMPLATES } from "@/modules/access/permissions";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [ik, iv] of flatten(v, `${prefix}${k}.`)) out.set(ik, iv);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();

describe("message catalogs", () => {
  const enKeys = flatten(en as Tree);
  const arKeys = flatten(ar as Tree);

  it("have exactly the same keys in English and Arabic", () => {
    expect([...arKeys.keys()].sort()).toEqual([...enKeys.keys()].sort());
  });

  it("use the same placeholders in both languages", () => {
    for (const [key, value] of enKeys)
      expect(placeholders(arKeys.get(key)!), key).toEqual(placeholders(value));
  });

  it("have no empty strings", () => {
    for (const [key, value] of [...enKeys, ...arKeys]) expect(value.trim(), key).not.toBe("");
  });

  it("label every permission and system role", () => {
    for (const p of PERMISSIONS) expect(enKeys.has(`roles.permissionLabels.${p}`), p).toBe(true);
    for (const r of SYSTEM_ROLE_TEMPLATES)
      expect(enKeys.has(`roles.names.${r.key}`), r.key).toBe(true);
  });
});
