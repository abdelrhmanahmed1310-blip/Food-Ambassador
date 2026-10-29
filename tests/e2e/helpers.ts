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
  opts: { name: string; email: string; organization: string },
): Promise<string> {
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Organization name").fill(opts.organization);
  await page.getByLabel("Base currency").selectOption("EGP");
  await page.getByLabel("Time zone").selectOption("Africa/Cairo");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[a-z0-9-]+$/);
  return new URL(page.url()).pathname.split("/")[2];
}
