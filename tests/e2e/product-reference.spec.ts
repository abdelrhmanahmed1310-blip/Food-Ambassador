import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

// Values are placeholders for the test; the app never ships nutrition data.
test("products linked to a library food: from the product page, the match screen and the upload (ADR-136)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Nutrition Lead",
    email: uniqueEmail("product-reference"),
    organization: "Reference Foods",
  });

  // A library food of our own, from a label.
  await page.goto(`/o/${slug}/nutrition/foods/new`);
  await page.getByLabel("Name (English)").fill("Testlabneh plain");
  await page.getByLabel("Energy (kcal)", { exact: true }).fill("160");
  await page.getByLabel("Protein (g)", { exact: true }).fill("6");
  await page.getByLabel("Total lipid (fat) (g)", { exact: true }).fill("11");
  await page.getByRole("button", { name: "Create food" }).click();
  await expect(page.getByRole("heading", { name: "Testlabneh plain" })).toBeVisible();

  // A new product: its nutrition page suggests the library food by name.
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("LAB-1KG");
  await page.getByLabel("Name (English)").fill("Testlabneh plain 1 kg tub");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Testlabneh plain 1 kg tub" })).toBeVisible();
  const productUrl = page.url();
  await page.goto(`${productUrl}/nutrition`);
  const card = page.getByTestId("product-reference");
  await expect(card).toContainText("No library food is linked yet.");
  await expect(card.getByText("Suggested for this product")).toBeVisible();
  await card.getByRole("button", { name: "Use: Testlabneh plain" }).click();
  await expect(card.getByText(/Linked as the product's nutrition reference\./)).toBeVisible();
  await expect(card.getByTestId("reference-food")).toHaveText("Testlabneh plain");
  await expect(card.getByTestId("reference-nutrient-count")).toContainText("Full profile:");
  // The label values were copied as unverified database values.
  await expect(page.getByTestId("nutrient-protein")).toContainText("6");

  // A second pack size, uploaded without a reference, is matched on the match screen.
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  const file = join(dir, "products.csv");
  writeFileSync(
    file,
    "sku,name_en,type,base_unit,reference_source,reference_id\nLAB-5KG,Testlabneh plain 5 kg bucket,RAW_MATERIAL,each,,\n",
  );
  await page.goto(`/o/${slug}/catalog/import`);
  const products = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Import products" }) });
  await products.locator('input[type="file"]').setInputFiles(file);
  await products.getByRole("button", { name: "Validate and import" }).click();
  await expect(products.getByText("1 row imported.")).toBeVisible();

  await page.goto(`/o/${slug}/nutrition/match`);
  await expect(page.getByTestId("reference-coverage")).toContainText("1");
  const row = page.getByTestId("match-row").filter({ hasText: "LAB-5KG" });
  await expect(row.getByRole("combobox")).toHaveValue("");
  await page.getByRole("button", { name: "Choose the first suggestion for every row" }).click();
  await page.getByRole("button", { name: "Link the chosen foods" }).click();
  await expect(page.getByText(/1 product linked\./)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Every food product here has a library food.")).toBeVisible();

  // Both pack sizes share the one library food.
  await page.goto(`/o/${slug}/nutrition/foods`);
  await page.getByRole("link", { name: "Testlabneh plain" }).first().click();
  await expect(page.getByTestId("linked-products")).toContainText("LAB-1KG");
  await expect(page.getByTestId("linked-products")).toContainText("LAB-5KG");

  // The product list filters by it.
  await page.goto(`/o/${slug}/catalog/products?nutrition=unlinked`);
  await expect(page.getByText("LAB-5KG")).toHaveCount(0);
  await context.close();
});
