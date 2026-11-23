import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("process menu with page tabs, the Settings page, and one-step product barcode and menu price (ADR-139)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("navigation"),
    organization: "Process Foods",
  });
  const nav = page.getByRole("navigation", { name: "Main" });
  await page.goto(`/o/${slug}`);
  // Process sections, a few links each.
  for (const section of ["Sell", "Procure to pay", "Stock & logistics", "People", "Settings"])
    await expect(nav.locator("summary", { hasText: new RegExp(`^${section}$`) })).toBeVisible();
  expect(await nav.getByRole("link").count()).toBeLessThanOrEqual(45);

  // Procure to pay › Buying: its pages as tabs, the menu marks the group.
  await nav.locator("summary", { hasText: /^Procure to pay$/ }).click();
  await nav.getByRole("link", { name: "Buying" }).click();
  const tabs = page.getByTestId("process-tabs");
  for (const tab of ["Requisitions", "Requests for quotation", "Purchase orders", "Reorder"])
    await expect(tabs.getByRole("link", { name: tab })).toBeVisible();
  await tabs.getByRole("link", { name: "Purchase orders" }).click();
  await expect(tabs.getByRole("link", { name: "Purchase orders" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link", { name: "Buying" })).toHaveAttribute("aria-current", "page");

  // Settings: one page with cards, and a way back from each setting.
  await nav.locator("summary", { hasText: /^Settings$/ }).click();
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-access")).toContainText("Members");
  await page.getByTestId("settings-organization").getByRole("link", { name: "Modules" }).click();
  await page.getByRole("link", { name: "← All settings" }).click();
  await expect(page.getByTestId("settings-organization")).toBeVisible();

  // A product with its barcode in one step.
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("WATER");
  await page.getByLabel("Name (English)").fill("Water bottle");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("textbox", { name: /^Barcode/ }).fill("6281000000014");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Water bottle" })).toBeVisible();
  await expect(page.getByText("6281000000014")).toBeVisible();

  // A menu item priced in the same step.
  await page.goto(`/o/${slug}/menu`);
  await page.getByLabel("Name", { exact: true }).fill("Drinks");
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByRole("link", { name: "New menu item" }).click();
  await page.getByLabel("Code", { exact: true }).fill("WATER");
  await page.getByLabel("Name", { exact: true }).fill("Water");
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: "WATER — Water bottle (each)" });
  await page.getByRole("textbox", { name: /^Price \(/ }).fill("3");
  await page.getByRole("checkbox", { name: "Delivery" }).uncheck();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "WATER — Water" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /3\.00/ })).toHaveCount(2);
  await context.close();
});
