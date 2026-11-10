import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

let counter = 0;

/** A distinct simulated client IP per context, so per-IP rate limits never collide between tests. */
function fakeIp(): string {
  counter += 1;
  const n = (Date.now() + counter * 7919 + Math.floor(Math.random() * 1e6)) % 16_000_000;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export async function newClient(
  browser: Browser,
  locale = "en-US",
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale,
    extraHTTPHeaders: { "x-forwarded-for": fakeIp() },
  });
  return { context, page: await context.newPage() };
}

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

export const PASSWORD = "e2e-password-1234";

/** Sign up through the UI; returns the organization slug from the landing URL. */
export async function signUp(
  page: Page,
  opts: {
    name: string;
    email: string;
    organization: string;
    baseCurrency?: string;
    timeZone?: string;
  },
): Promise<string> {
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Organization name").fill(opts.organization);
  await page.getByLabel("Base currency").selectOption(opts.baseCurrency ?? "EGP");
  await page.getByLabel("Time zone").selectOption(opts.timeZone ?? "Africa/Cairo");
  await page.getByRole("button", { name: "Create organization" }).click();
  // The first sign-up after the server starts also warms its database pool and
  // password hashing; allow for that instead of the default 5 s.
  await expect(page).toHaveURL(/\/o\/[a-z0-9-]+$/, { timeout: 20_000 });
  return new URL(page.url()).pathname.split("/")[2];
}

/**
 * A calendar date in the organization's time zone (sign-up defaults to
 * Cairo), `days` from today. Never the UTC date: between 22:00 and 24:00
 * UTC, Cairo is already on the next day.
 */
export function orgDate(days = 0, timeZone = "Africa/Cairo"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 86_400_000));
}
