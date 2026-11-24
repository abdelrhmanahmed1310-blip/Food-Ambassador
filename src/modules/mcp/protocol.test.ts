import { describe, expect, it } from "vitest";
import { ERRORS, handleBody, handleMessage, negotiateVersion, type ToolHost } from "./protocol";

/** The MCP protocol layer (ADR-143). */

const host: ToolHost = {
  list: () => [
    {
      name: "list_sites",
      title: "List sites",
      description: "Sites.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
    },
    {
      name: "decide_agent_proposal",
      title: "Decide",
      description: "Decide.",
      inputSchema: { type: "object" },
      readOnly: false,
    },
  ],
  async call(name, input) {
    if (name === "list_sites") return { ok: true, data: { sites: ["RUH"], input } };
    if (name === "decide_agent_proposal") return { ok: false, error: "Not permitted." };
    return null;
  },
};
const req = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("MCP protocol", () => {
  it("negotiates the protocol version and describes the server", async () => {
    expect(negotiateVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateVersion("1999-01-01")).toBe("2025-11-25");
    const r = (await handleMessage(
      req("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {} }),
      host,
    )) as { result: Record<string, unknown> };
    expect(r.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "food-ambassador" },
    });
    expect(r.result.instructions).toMatch(/confirm with the person before approving/);
  });

  it("lists tools with read-only and destructive hints", async () => {
    const r = (await handleMessage(req("tools/list"), host)) as {
      result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    };
    expect(
      r.result.tools.map((t) => [
        t.name,
        t.annotations.readOnlyHint,
        t.annotations.destructiveHint,
      ]),
    ).toEqual([
      ["list_sites", true, false],
      ["decide_agent_proposal", false, true],
    ]);
  });

  it("returns tool results as text and structured content, and tool errors as isError", async () => {
    const ok = (await handleMessage(
      req("tools/call", { name: "list_sites", arguments: { q: 1 } }),
      host,
    )) as { result: { content: Array<{ text: string }>; structuredContent: unknown } };
    expect(ok.result.structuredContent).toEqual({ sites: ["RUH"], input: { q: 1 } });
    expect(JSON.parse(ok.result.content[0].text)).toEqual(ok.result.structuredContent);
    const refused = (await handleMessage(
      req("tools/call", { name: "decide_agent_proposal", arguments: {} }),
      host,
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect([refused.result.isError, refused.result.content[0].text]).toEqual([
      true,
      "Not permitted.",
    ]);
    const unknown = (await handleMessage(req("tools/call", { name: "drop_tables" }), host)) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(ERRORS.INVALID_PARAMS);
    const badArgs = (await handleMessage(
      req("tools/call", { name: "list_sites", arguments: [1] }),
      host,
    )) as { error: { code: number } };
    expect(badArgs.error.code).toBe(ERRORS.INVALID_PARAMS);
  });

  it("answers requests only: notifications and responses get nothing back", async () => {
    expect(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, host),
    ).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", id: 9, result: {} }, host)).toBeNull();
    expect(await handleMessage(req("ping"), host)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(
      ((await handleMessage(req("resources/list"), host)) as { error: { code: number } }).error
        .code,
    ).toBe(ERRORS.METHOD_NOT_FOUND);
    expect(
      ((await handleMessage({ id: 1, method: "ping" }, host)) as { error: { code: number } }).error
        .code,
    ).toBe(ERRORS.INVALID_REQUEST);
  });

  it("handles a batch from older clients", async () => {
    const r = await handleBody(
      [
        req("ping", undefined, "a"),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        req("tools/list", undefined, "b"),
      ],
      host,
    );
    expect((r as Array<{ id: string }>).map((x) => x.id)).toEqual(["a", "b"]);
    expect(
      await handleBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], host),
    ).toBeNull();
  });
});
