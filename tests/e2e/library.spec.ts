import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

// An Open Food Facts product JSON in the published shape; values are placeholders for the test.
const offProduct = {
  code: "0000000000048",
  product: {
    product_name: "Test tahini paste",
    product_name_ar: "طحينة تجريبية",
    product_quantity_unit: "g",
    nutriments: { "energy-kcal_100g": 600, fat_100g: 50, "saturated-fat_100g": 7, salt_100g: 0.1 },
    allergens_tags: ["en:sesame-seeds"],
    traces_tags: ["en:peanuts"],
  },
};

test("ingredient library: import a file once, use a record for a product as unverified data", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Purchasing Lead",
    email: uniqueEmail("library"),
    organization: "Library Foods",
  });
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("TAHINI");
  await page.getByLabel("Name (English)").fill("Tahini");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Tahini" })).toBeVisible();

  const file = join(tmpdir(), `off-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(offProduct));
  await page.goto(`/o/${slug}/catalog/library`);
  await expect(page.getByText("No library records yet.")).toBeVisible();
  await page.locator("#library-source").selectOption("OPEN_FOOD_FACTS");
  await page.locator("#library-file").setInputFiles(file);
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("Imported: 1 new, 0 updated, 0 skipped.")).toBeVisible();
  await page.locator("#library-source").selectOption("OPEN_FOOD_FACTS");
  await page.locator("#library-file").setInputFiles(file);
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("This file was already imported; nothing changed.")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("library-0000000000048")).toContainText("Sesame");
  await page.getByRole("link", { name: "Test tahini paste" }).click();
  await expect(page.getByText(/Open Database License/)).toBeVisible();
  await expect(page.getByTestId("ref-nutrient-fat")).toContainText("50");
  await page.getByLabel("Product").selectOption({ label: "TAHINI — Tahini" });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    page.getByText(
      /Nutrition values copied \(not verified yet\)\. 2 allergen statements added\. Arabic name filled in\./,
    ),
  ).toBeVisible();

  await page.getByRole("link", { name: /^TAHINI/ }).click();
  await expect(page.getByText("Food database").first()).toBeVisible();
  await expect(page.getByText("Not verified", { exact: true })).toBeVisible();
  await expect(page.getByTestId("allergen-SESAME")).toContainText("Contains");
  await expect(page.getByTestId("allergen-PEANUTS")).toContainText("May contain");
  // Not listed is not absent.
  await expect(page.getByTestId("allergen-MILK")).toContainText("Unknown");
  await expect(page.getByRole("link", { name: "Copied from a library record" })).toBeVisible();
  await context.close();
});
