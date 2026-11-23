import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("any product type on the menu in one category, punched and scanned in the POS simulator (ADR-138)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "menu-all-types");

  // An ingredient, a semi-finished product and packaging, next to the Cola (finished good).
  const file = join(mkdtempSync(join(tmpdir(), "types-")), "products.csv");
  writeFileSync(
    file,
    [
      "sku,name_en,type,base_unit",
      "TOMATO,Tomato,RAW_MATERIAL,kg",
      "DOUGH,Pizza dough,SEMI_FINISHED,kg",
      "BOX,Takeaway box,PACKAGING,each",
    ].join("\n"),
  );
  await page.goto(`/o/${slug}/catalog/import`);
  const products = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Import products" }) });
  await products.locator('input[type="file"]').setInputFiles(file);
  await products.getByRole("button", { name: "Validate and import" }).click();
  await expect(products.getByText("3 rows imported.")).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products`);
  await page.getByRole("link", { name: "Tomato", exact: true }).click();
  await page.getByLabel("Barcode", { exact: true }).fill("TOMATO-1");
  await page.getByLabel("Barcode type").selectOption("CODE128");
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByText("TOMATO-1")).toBeVisible();

  // Menu → Add products and dishes: the three, priced, into the Drinks category.
  await page.goto(`/o/${slug}/menu`);
  await page.getByRole("link", { name: "Add products and dishes" }).click();
  const tomatoRow = page.getByTestId("add-row").filter({ hasText: "Tomato" });
  await expect(tomatoRow).toContainText("Raw material");
  await expect(page.getByTestId("add-row").filter({ hasText: "Cola can" })).toContainText(
    "Already on the menu",
  );
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  for (const [name, price] of [
    ["Tomato", "5"],
    ["Pizza dough", "5"],
    ["Takeaway box", "1"],
  ]) {
    await page.getByRole("checkbox", { name, exact: true }).check();
    await page.getByLabel(`Price: ${name}`).fill(price);
  }
  await page.getByRole("button", { name: "Add to the menu" }).click();
  await expect(page.getByText("3 items added.")).toBeVisible();

  // The simulator sells them all from the one category: punched and scanned.
  await page.goto(`/o/${slug}/pos/simulator`);
  for (const name of ["Cola", "Tomato", "Pizza dough", "Takeaway box"])
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  await page
    .getByRole("button", { name: /^Tomato/ })
    .first()
    .click();
  const scan = page.getByLabel("Scan or type a barcode");
  await scan.fill("TOMATO-1");
  await scan.press("Enter");
  await expect(page.getByText(/Scanned TOMATO-1: Tomato/)).toBeVisible();
  await page
    .getByRole("button", { name: /^Pizza dough/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^Takeaway box/ })
    .first()
    .click();
  await expect(page.getByTestId("sim-total")).toHaveText(/EGP\s?16\.00/);
  await page.getByRole("button", { name: "Complete test sale" }).click();
  await expect(page.getByTestId("sim-receipt-total")).toHaveText(/EGP\s?16\.00/);
  await context.close();
});
