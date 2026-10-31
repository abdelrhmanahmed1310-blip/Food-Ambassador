import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanWithClamd } from "./scanner";

// A stand-in that speaks clamd's INSTREAM protocol, to test framing and
// replies; the integration test uses a real clamd when CLAMAV_TEST_URL is set.
let server: Server;
let url: string;
let received = Buffer.alloc(0);

beforeAll(async () => {
  server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const header = "zINSTREAM\0";
      if (!buf.subarray(0, header.length).equals(Buffer.from(header))) return;
      let pos = header.length;
      const parts: Buffer[] = [];
      while (pos + 4 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        if (len === 0) {
          received = Buffer.concat(parts);
          socket.end(received.includes("EVIL") ? "stream: Test.Evil FOUND\0" : "stream: OK\0");
          return;
        }
        if (pos + 4 + len > buf.length) return;
        parts.push(buf.subarray(pos + 4, pos + 4 + len));
        pos += 4 + len;
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `tcp://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("clamd INSTREAM client (ADR-055)", () => {
  it("streams the whole file in chunks and reads clean and infected replies", async () => {
    const big = Buffer.alloc(200_000, 0x41);
    expect(await scanWithClamd(url, big)).toEqual({ status: "CLEAN" });
    expect(received.equals(big)).toBe(true); // reassembled from 64 KB chunks
    expect(await scanWithClamd(url, Buffer.from("xx EVIL xx"))).toEqual({
      status: "INFECTED",
      signature: "Test.Evil",
    });
  });

  it("reports an unreachable scanner as an error", async () => {
    const r = await scanWithClamd("tcp://127.0.0.1:1", Buffer.from("x"), { timeoutMs: 2000 });
    expect(r.status).toBe("ERROR");
  });
});
