import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "./client";
import { probeDatabase } from "./probe";
import { checkReadiness } from "@/server/health";

afterAll(async () => {
  await getDb().$disconnect();
});

describe("database connectivity", () => {
  it("connects to the test database", async () => {
    const rows = await getDb().$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    expect(rows[0].db).toMatch(/test/);
  });

  it("round-trips NUMERIC values exactly", async () => {
    const rows = await getDb().$queryRaw<Array<{ v: unknown }>>`
      SELECT (0.1::numeric(20,6) + 0.2::numeric(20,6)) AS v`;
    expect(String(rows[0].v)).toBe("0.3");
  });

  it("passes the readiness probe", async () => {
    await expect(probeDatabase()).resolves.toBeUndefined();
    const report = await checkReadiness({ database: probeDatabase });
    expect(report.status).toBe("ok");
  });
});
