import { expect, test } from "@playwright/test";

test("strict content security policy: nonce scripts only, and the app still runs (ADR-074)", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });

  const first = await page.goto("/sign-in");
  const policy = first!.headers()["content-security-policy"];
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(policy).not.toContain("unsafe-eval");
  const nonce = /'nonce-([^']+)'/.exec(policy)![1];

  // Every script Next.js rendered carries this request's nonce.
  const scripts = await page
    .locator("script")
    .evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  for (const n of scripts) expect(n).toBe(nonce);

  // A new request gets a new nonce.
  const second = await page.reload();
  expect(second!.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);

  // The nonce'd scripts ran: the Next.js client booted (it sets window.next).
  await page.waitForFunction(() =>
    Boolean((window as unknown as { next?: { version?: string } }).next?.version),
  );

  // The real page needed nothing the policy refuses.
  expect(violations).toEqual([]);

  // Injected markup (the usual XSS shape) cannot run code: inline handlers are refused.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = '<img src="/missing.png" onerror="window.__injected = true">';
    document.body.appendChild(d);
  });
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected),
  ).toBeUndefined();
  expect(violations.length).toBeGreaterThan(0);
});
