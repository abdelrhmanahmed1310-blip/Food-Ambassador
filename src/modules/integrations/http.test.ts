import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postWebhook } from "./http";

let server: Server;
let port: number;
const bodies: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.statusCode = req.url === "/redirect" ? 302 : 204;
      if (req.url === "/redirect") res.setHeader("Location", "http://example.com/");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("postWebhook", () => {
  it("posts the body and returns the status without following redirects", async () => {
    const opts = { allowPrivate: true, timeoutMs: 2000 };
    expect(await postWebhook(`http://localhost:${port}/ok`, {}, '{"a":1}', opts)).toBe(204);
    expect(await postWebhook(`http://localhost:${port}/redirect`, {}, "{}", opts)).toBe(302);
    expect(bodies).toEqual(['{"a":1}', "{}"]);
  });

  it("refuses at connect time a host name that resolves to a private address", async () => {
    // "localhost" passes no literal-IP check; the guard sees the dialled 127.0.0.1.
    await expect(
      postWebhook(`http://localhost:${port}/ok`, {}, "{}", {
        allowPrivate: false,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow("privateAddress");
    expect(bodies).toHaveLength(2);
  });
});
