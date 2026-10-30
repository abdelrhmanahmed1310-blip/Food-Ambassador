import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("VAT: Saudi preset, registration, VAT on imported sales and the VAT summary", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("vat"),
    organization: "Riyadh Foods",
  });
  await page.goto(`/o/${slug}/settings/tax`);
  const preset = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Apply preset" }) });
  await preset.getByLabel("Country").selectOption("SA");
  await preset.getByRole("button", { name: "Apply preset" }).click();
  await expect(page.getByText("Preset applied.")).toBeVisible();
  await expect(page.getByTestId("tax-code-STD")).toContainText("15 %");
  await expect(page.getByTestId("tax-code-STD")).toContainText("2020-07-01");

  const settings = page.locator("form").filter({ has: page.getByLabel("VAT registration number") });
  await settings.getByLabel("Country").selectOption("SA");
  await settings.getByLabel(/^VAT registered/).check();
  await settings.getByLabel("VAT registration number").fill("123456789012345");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("The VAT number does not have the expected format for this country."),
  ).toBeVisible();
  await settings.getByLabel("VAT registration number").fill("310122393500003");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();

  // Stock and a product sold as-is.
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Riyadh");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Riyadh" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KITCH");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("WATER");
  await page.getByLabel("Name (English)").fill("Water");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Water" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "KITCH — Kitchen" });
  await page.getByLabel("Product").selectOption({ label: "WATER — Water (each)" });
  await page.getByLabel("Quantity").fill("50");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "each — Each" });
  await page.getByLabel("Unit cost").fill("1");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  const file = join(tmpdir(), `vat-${Date.now()}.csv`);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    file,
    `date,external_id,item_code,quantity,gross_amount\n${today},W-1,WATER,2,23.00\n`,
  );
  await page.goto(`/o/${slug}/sales`);
  await page.getByLabel("Warehouse").selectOption({ label: "KITCH — Kitchen" });
  await page.getByLabel(/^CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("1 line imported.")).toBeVisible();
  await page.getByRole("link", { name: /^SAL-/ }).first().click();
  // 23.00 incl. 15 % → 3.00 VAT.
  await expect(page.getByTestId("sales-vat")).toHaveText(/SAR\s?3\.00|3\.00\s?SAR|EGP\s?3\.00/);

  await page.goto(`/o/${slug}/sales/vat`);
  await expect(page.getByTestId("vat-STD")).toContainText("15 %");
  await expect(page.getByTestId("vat-STD")).toContainText(/3\.00/);
  await context.close();
});
