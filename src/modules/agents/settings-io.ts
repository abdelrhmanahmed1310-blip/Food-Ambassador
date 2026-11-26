import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/modules/tenancy/context";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { AGENT_KINDS, AUTONOMY_FOR, settingsSchema, type AgentKindCode } from "./rules";
import { agentFormOptions, listAgents, updateAgent } from "./service";

/**
 * Agent settings for outside agents (DECISIONS.md ADR-160): the same settings
 * as the Agents page, through the same service (settings managers only, the
 * same validation, audit and "whoever switches it on lends it their access").
 * Warehouses and branches are named by their codes, never by record ids.
 */

type Settings = Record<string, unknown>;

/** Every agent's settings as an outside agent reads them. */
export async function agentSettingsView(ctx: TenantContext) {
  const [agents, options] = await Promise.all([listAgents(ctx), agentFormOptions(ctx)]);
  const whCode = new Map(options.warehouses.map((w) => [w.id, w.code]));
  const brCode = new Map(options.branches.map((b) => [b.id, b.code]));
  return agents.map((a) => {
    const { warehouseIds, branchIds, ...rest } = a.settings as Settings & {
      warehouseIds?: string[];
      branchIds?: string[];
    };
    return {
      agent: a.kind,
      enabled: a.enabled,
      autonomy: a.autonomy,
      offeredAutonomy: AUTONOMY_FOR[a.kind],
      runHour: a.runHour,
      runDays: a.runDays,
      settings: {
        ...rest,
        ...(warehouseIds ? { warehouses: warehouseIds.flatMap((id) => whCode.get(id) ?? []) } : {}),
        ...(branchIds ? { branches: branchIds.flatMap((id) => brCode.get(id) ?? []) } : {}),
      },
    };
  });
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    autonomy: z.string().optional(),
    runHour: z.number().int().min(0).max(23).optional(),
    runDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Change some of one agent's settings; what is not given stays as it is.
 * `settings.warehouses` / `settings.branches` take codes.
 */
export async function updateAgentSettings(ctx: TenantContext, kind: AgentKindCode, raw: unknown) {
  if (!AGENT_KINDS.includes(kind)) throw notFound("Agent");
  const parsed = patchSchema.safeParse(raw ?? {});
  if (!parsed.success) throw validationFailed(parsed.error);
  const patch = parsed.data;
  const [agents, options] = await Promise.all([listAgents(ctx), agentFormOptions(ctx)]);
  const current = agents.find((a) => a.kind === kind);
  if (!current) throw notFound("Agent");

  const allowed = new Set([...Object.keys(settingsSchema(kind).shape), "warehouses", "branches"]);
  const given = { ...(patch.settings ?? {}) };
  const unknown = Object.keys(given).filter(
    (k) => !allowed.has(k) || k === "warehouseIds" || k === "branchIds",
  );
  if (unknown.length)
    throw businessRuleViolation(
      "AGENT_SETTING_UNKNOWN",
      `Not a setting of this agent: ${unknown.join(", ")}`,
    );
  const byCode = (list: Array<{ id: string; code: string }>, codes: unknown, what: string) => {
    if (!Array.isArray(codes) || codes.some((c) => typeof c !== "string"))
      throw businessRuleViolation("AGENT_SETTING_UNKNOWN", `${what} must be a list of codes`);
    return (codes as string[]).map((c) => {
      const hit = list.find((x) => x.code === c);
      if (!hit) throw businessRuleViolation("AGENT_SETTING_UNKNOWN", `Unknown ${what}: ${c}`);
      return hit.id;
    });
  };
  const { warehouses, branches, ...plain } = given;
  const settings: Settings = {
    ...(current.settings as Settings),
    ...plain,
    ...(warehouses !== undefined
      ? { warehouseIds: byCode(options.warehouses, warehouses, "warehouse") }
      : {}),
    ...(branches !== undefined ? { branchIds: byCode(options.branches, branches, "branch") } : {}),
  };
  await updateAgent(ctx, kind, {
    enabled: patch.enabled ?? current.enabled,
    autonomy: patch.autonomy ?? current.autonomy,
    runHour: patch.runHour ?? current.runHour,
    runDays: patch.runDays ?? current.runDays,
    settings,
  });
  return (await agentSettingsView(ctx)).find((a) => a.agent === kind)!;
}
