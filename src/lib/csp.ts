/**
 * Content Security Policy with a per-request nonce (ADR-074).
 *
 * Scripts run only when they carry this request's nonce; 'strict-dynamic' lets
 * those scripts load the app's own chunks. Next.js reads the nonce from the
 * request's CSP header and stamps it on its framework and page scripts, so every
 * page must render per request (all pages do: the root layout reads the locale).
 *
 * Styles keep 'unsafe-inline': React sets `style` attributes (floor plan grid,
 * recipe indents), which nonces cannot cover. Style injection cannot run code.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // Dev only: React rebuilds server error stacks with eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // QR codes are data: URLs drawn in the browser.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
