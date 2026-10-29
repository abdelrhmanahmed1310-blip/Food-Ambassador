import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("mobile layout uses the menu toggle and has no horizontal scroll", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, {
    name: "Mobile",
    email: uniqueEmail("mobile"),
    organization: "Mobile Foods",
  });
  const toggle = page.getByRole("button", { name: "Open menu" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.locator("#mobile-nav").getByRole("link", { name: "Branches" }).click();
  await expect(page.getByRole("heading", { name: "Branches" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});
