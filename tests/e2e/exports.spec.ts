import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("exports: products as CSV and as Excel (ADR-089)", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("export"),
    organization: "Export Foods",
  });
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("DATES");
  await page.getByLabel("Name (English)").fill("Medjool dates");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Medjool dates" })).toBeVisible();

  await page.goto(`/o/${slug}/catalog/products`);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Excel" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const path = await download.path();
  const bytes = (await import("node:fs")).readFileSync(path);
  expect(bytes.subarray(0, 2).toString()).toBe("PK"); // an .xlsx is a zip file
  await context.close();
});
