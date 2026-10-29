import { afterAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/uuid";
import { getDb } from "@/server/db/client";
import { consumeRateLimit } from "@/server/rate-limit";
import { uniqueEmail } from "../../../test/support/factories";
import { getAuth } from "./auth";

afterAll(async () => {
  await getDb().$disconnect();
});

const PASSWORD = "correct-horse-battery";

describe("authentication (Better Auth + Prisma)", () => {
  it("signs up with a hashed password and a UUIDv7 user id", async () => {
    const email = uniqueEmail("signup");
    const result = await getAuth().api.signUpEmail({
      body: { name: "Sign Up", email, password: PASSWORD },
    });
    expect(result.user.email).toBe(email);
    expect(result.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    const account = await getDb().account.findFirstOrThrow({
      where: { userId: result.user.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(PASSWORD);
    const user = await getDb().user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(user).toMatchObject({ status: "ACTIVE", locale: "en" });
  });

  it("rejects duplicate emails and short passwords", async () => {
    const email = uniqueEmail("dupe");
    await getAuth().api.signUpEmail({ body: { name: "A", email, password: PASSWORD } });
    await expect(
      getAuth().api.signUpEmail({ body: { name: "B", email, password: PASSWORD } }),
    ).rejects.toThrow();
    await expect(
      getAuth().api.signUpEmail({
        body: { name: "C", email: uniqueEmail("short"), password: "short" },
      }),
    ).rejects.toThrow();
  });

  it("signs in with the right password only, and the session resolves server-side", async () => {
    const email = uniqueEmail("signin");
    await getAuth().api.signUpEmail({ body: { name: "Sign In", email, password: PASSWORD } });
    await expect(
      getAuth().api.signInEmail({ body: { email, password: "wrong-password-123" } }),
    ).rejects.toThrow();

    const { headers } = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    const cookie = headers.get("set-cookie")!;
    expect(cookie).toMatch(/session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);

    const sessionCookie = cookie.split(";")[0];
    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie: sessionCookie }),
    });
    expect(session?.user.email).toBe(email);

    // Expired sessions are rejected.
    await getDb().session.updateMany({
      where: { userId: session!.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      await getAuth().api.getSession({ headers: new Headers({ cookie: sessionCookie }) }),
    ).toBeNull();
  });
});

describe("rate limiting", () => {
  it("allows up to max requests per window, then reports retryAfter", async () => {
    const key = `test:${uuidv7()}`;
    const rule = { window: 60, max: 3 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeRateLimit(key, rule));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3].retryAfter).toBeGreaterThan(0);
  });

  it("is atomic under concurrency", async () => {
    const key = `test:${uuidv7()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(key, { window: 60, max: 5 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("resets after the window elapses", async () => {
    const key = `test:${uuidv7()}`;
    await consumeRateLimit(key, { window: 60, max: 1 });
    expect((await consumeRateLimit(key, { window: 60, max: 1 })).allowed).toBe(false);
    await getDb().rateLimitBucket.update({
      where: { key },
      data: { windowStart: new Date(Date.now() - 61_000) },
    });
    expect((await consumeRateLimit(key, { window: 60, max: 1 })).allowed).toBe(true);
  });
});
