import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isPrivateAddress } from "./crypto";

/**
 * POST a webhook body and return the response status (ADR-048). The address
 * is checked again at connect time, on the IP actually dialled, so a DNS
 * answer that changes after validation (DNS rebinding) cannot reach a
 * private network. No redirects are followed; the response body is
 * discarded.
 */
export function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  options: { allowPrivate: boolean; timeoutMs: number },
): Promise<number> {
  const target = new URL(url);
  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) =>
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      const list = addresses as LookupAddress[];
      const blocked = !options.allowPrivate && list.some((a) => isPrivateAddress(a.address));
      if (blocked || list.length === 0) return callback(new Error("privateAddress"), "", 4);
      if (lookupOptions.all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        lookup: guardedLookup,
        // A fresh connection every time: a pooled socket would skip the lookup check.
        agent: false,
        timeout: options.timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
