"use client";

import { syncOutcome } from "@/modules/pos/rules";

/**
 * The till's order queue on the device (ADR-060). Every paid order is saved
 * here before it is sent, so a sale taken without a connection — or whose
 * response was lost — is never lost: it stays until the server has it.
 * IndexedDB survives reloads and closing the app; it is per browser profile.
 */

export interface QueuedOrder {
  orderId: string;
  orgSlug: string;
  registerId: string;
  cashierUserId: string;
  payload: Record<string, unknown>;
  /** For the list on the screen. */
  total: string;
  takenAt: string;
  status: "pending" | "refused";
  error?: string;
  attempts: number;
}

export type SendResult =
  | { outcome: "recorded"; number: string; id: string; change: string; shortfalls: number }
  | { outcome: "refused"; error: string }
  | { outcome: "retry" }
  | { outcome: "signedOut" };

const DB = "food-ambassador-pos";
const STORE = "orders";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: "orderId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const saveOrder = (o: QueuedOrder) => run("readwrite", (s) => s.put(o));
export const removeOrder = (orderId: string) => run("readwrite", (s) => s.delete(orderId));

/** Orders of this register taken by this person, oldest first. */
export async function listOrders(registerId: string, cashierUserId: string) {
  const all = (await run("readonly", (s) => s.getAll())) as QueuedOrder[];
  return all
    .filter((o) => o.registerId === registerId && o.cashierUserId === cashierUserId)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

/** All orders waiting on this device for a register, whoever took them. */
export async function countForRegister(registerId: string) {
  const all = (await run("readonly", (s) => s.getAll())) as QueuedOrder[];
  return all.filter((o) => o.registerId === registerId).length;
}

/** Send one order. Network errors and server errors mean "try again later". */
export async function sendOrder(o: QueuedOrder): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`/o/${o.orgSlug}/pos/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o.payload),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { outcome: "retry" };
  }
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  const outcome = syncOutcome(res.redirected ? 200 : res.status, json && !res.redirected);
  if (outcome === "recorded") {
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      id?: string;
      number?: string;
      change?: string;
      shortfalls?: number;
    } | null;
    if (!body?.ok || !body.number) return { outcome: "retry" };
    return {
      outcome: "recorded",
      id: body.id ?? o.orderId,
      number: body.number,
      change: body.change ?? "0",
      shortfalls: body.shortfalls ?? 0,
    };
  }
  if (outcome === "refused") {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { outcome: "refused", error: body?.error || `HTTP ${res.status}` };
  }
  return { outcome };
}

let running: Promise<void> | null = null;

/**
 * Send pending orders oldest first, one at a time. Stops at the first order
 * that cannot be sent now (offline, signed out) so the order of sales is
 * kept; refused orders are set aside with their reason.
 */
export function syncPending(
  registerId: string,
  cashierUserId: string,
  onUpdate: (state: { signedOut: boolean }) => void,
): Promise<void> {
  running ??= (async () => {
    try {
      let signedOut = false;
      for (const o of await listOrders(registerId, cashierUserId)) {
        if (o.status !== "pending") continue;
        const r = await sendOrder(o);
        if (r.outcome === "recorded") await removeOrder(o.orderId);
        else if (r.outcome === "refused")
          await saveOrder({ ...o, status: "refused", error: r.error, attempts: o.attempts + 1 });
        else {
          await saveOrder({ ...o, attempts: o.attempts + 1 });
          signedOut = r.outcome === "signedOut";
          break;
        }
      }
      onUpdate({ signedOut });
    } finally {
      running = null;
    }
  })();
  return running;
}
