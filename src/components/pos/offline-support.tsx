"use client";

import { useEffect } from "react";

/**
 * Installs the service worker that lets the till load without a connection
 * (ADR-060), and hands it the build files this page already loaded so that
 * the very next load works offline.
 */
export function OfflineSupport() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    (async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        const registration = await navigator.serviceWorker.ready;
        if (cancelled) return;
        const assets = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .filter((u) => new URL(u).pathname.startsWith("/_next/static/"));
        registration.active?.postMessage({
          type: "cache-till",
          page: location.pathname,
          assets,
        });
      } catch {
        // No service worker (private window, old browser): the till still works online.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

/** Removes cached till pages (they show the menu and register) when someone signs out. */
export function ClearOfflinePages() {
  useEffect(() => {
    if (!("caches" in window)) return;
    void caches.delete("fa-pos-pages-v1").catch(() => undefined);
  }, []);
  return null;
}
