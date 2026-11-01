import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("point of sale: register, shift, cash sale with change, receipt, close with Z report", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos");
  await page.getByRole("link", { name: "Open till" }).click();

  // Two colas, paid in cash with 100: change 50. No stock was recorded, so a shortfall is noted.
  const cola = page.getByRole("button", { name: /Cola/ }).first();
  await cola.click();
  await cola.click();
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?50\.00/);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByLabel("Cash received").fill("100");
  await expect(page.getByText(/Change\s+EGP\s?50\.00/)).toBeVisible();
  await page.getByRole("button", { name: "Take payment" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  await expect(page.getByText(/Change:\s+EGP\s?50\.00/)).toBeVisible();
  await expect(page.getByText(/listed under stock shortfalls/)).toBeVisible();
  await expect(page.getByTestId("till-total")).toHaveText(/EGP\s?0\.00/);

  const receiptHref = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");
  await page.goto(receiptHref!);
  await expect(page.getByText(/2 × Cola/)).toBeVisible();
  await expect(page.getByText("Thank you")).toBeVisible();

  // The same till on a phone: items and total fit without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await page.getByRole("link", { name: "Open till" }).click();
  await expect(page.getByRole("button", { name: /Cola/ }).first()).toBeVisible();
  await expect(page.getByTestId("till-total")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(`/o/${slug}/pos/shortfalls`);
  await expect(page.getByRole("cell", { name: /COLA/ })).toBeVisible();

  // Close: expected cash = 100 float + 50 sales; counted 150 → no difference.
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await page.getByLabel(/^Cash counted/).fill("150");
  await page.getByRole("button", { name: "Close shift" }).click();
  await expect(page.getByRole("heading", { name: /^Z report SHF-/ })).toBeVisible();
  const expected = page
    .locator("dt", { hasText: "Expected cash" })
    .locator("xpath=following-sibling::dd[1]");
  await expect(expected).toHaveText(/EGP\s?150\.00/);
  const difference = page
    .locator("dt", { hasText: "Difference" })
    .locator("xpath=following-sibling::dd[1]");
  await expect(difference).toHaveText(/EGP\s?0\.00/);
  await context.close();
});

test("cashier app: installable, sells offline, reloads offline and sends the queue when back online", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-offline");
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ display: "standalone", start_url: "/" });

  await page.getByRole("link", { name: "Open till" }).click();
  await expect(page.getByText("All orders sent")).toBeVisible();
  // The service worker takes over; one online load stores the till for offline use.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await expect(page.getByRole("button", { name: /Cola/ }).first()).toBeVisible();

  // No connection: the sale is paid and kept on the device.
  await context.setOffline(true);
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: "Card approved" }).click();
  await expect(page.getByText(/saved on this device/)).toBeVisible();
  await expect(page.getByText("1 order waiting to be sent")).toBeVisible();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();

  // Reloading without a connection still opens the till, with the order still waiting.
  await page.reload();
  await expect(page.getByRole("button", { name: /Cola/ }).first()).toBeVisible();
  await expect(page.getByText("1 order waiting to be sent")).toBeVisible();

  // Back online: the queue is sent and the order is in the shift.
  await context.setOffline(false);
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByText("All orders sent")).toBeVisible();
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "TILL1" }).click();
  await expect(page.getByRole("link", { name: /^POS-/ })).toHaveCount(1);
  await expect(page.getByTestId("pending-sync")).toHaveCount(0);
  await context.close();
});
