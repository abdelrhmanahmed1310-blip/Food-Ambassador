import "server-only";
import { connect } from "node:net";

/**
 * Virus scanning with a ClamAV daemon (DECISIONS.md ADR-055) using clamd's
 * INSTREAM command: "zINSTREAM\0", then chunks of [4-byte big-endian length]
 * [bytes], then a zero-length chunk; the reply is "stream: OK" or
 * "stream: <signature> FOUND".
 */

export type ScanResult =
  | { status: "CLEAN" }
  | { status: "INFECTED"; signature: string }
  | { status: "ERROR"; message: string };

const CHUNK = 64 * 1024;

export function scanWithClamd(
  url: string,
  data: Uint8Array,
  options: { timeoutMs?: number } = {},
): Promise<ScanResult> {
  const { hostname, port } = new URL(url.replace(/^tcp:/, "http:"));
  return new Promise((resolve) => {
    let reply = "";
    let done = false;
    const finish = (r: ScanResult) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // end of stream
    });
    socket.setTimeout(options.timeoutMs ?? 15_000, () =>
      finish({ status: "ERROR", message: "timeout" }),
    );
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8");
      if (reply.includes("\0")) socket.end();
    });
    socket.on("error", (e) => finish({ status: "ERROR", message: e.message }));
    socket.on("close", () => {
      const text = reply.replace(/\0/g, "").trim();
      if (/^stream: OK$/.test(text)) return finish({ status: "CLEAN" });
      const found = /^stream: (.+) FOUND$/.exec(text);
      if (found) return finish({ status: "INFECTED", signature: found[1] });
      finish({ status: "ERROR", message: text || "no reply" });
    });
  });
}
