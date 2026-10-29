import { describe, expect, it } from "vitest";
import { inSequence } from "./transactions";

/** A lazy thenable like a PrismaPromise: work starts only when awaited. */
function lazy<T>(log: string[], name: string, value: T, ms: number): PromiseLike<T> {
  return {
    then(resolve, reject) {
      log.push(`start ${name}`);
      return new Promise<T>((r) => setTimeout(() => r(value), ms))
        .then((v) => {
          log.push(`end ${name}`);
          return v;
        })
        .then(resolve, reject);
    },
  };
}

describe("inSequence", () => {
  it("runs lazy queries strictly one after another and keeps result order", async () => {
    const log: string[] = [];
    const [a, b, c] = await inSequence([lazy(log, "a", 1, 20), lazy(log, "b", "two", 5), lazy(log, "c", null, 1)]);
    expect([a, b, c]).toEqual([1, "two", null]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("accepts plain values and propagates the first failure", async () => {
    await expect(inSequence([Promise.resolve(1), 2 as const])).resolves.toEqual([1, 2]);
    await expect(inSequence([Promise.reject(new Error("boom")), Promise.resolve(1)])).rejects.toThrow("boom");
  });
});
