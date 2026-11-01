import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("ZATCA: Saudi seller details, Phase 1 QR on receipts, a register's unit prepared for onboarding", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("zatca"),
    organization: "Riyadh Grill",
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  });
  // VAT registration in Saudi Arabia (prices include VAT).
  await page.goto(`/o/${slug}/settings/tax`);
  const preset = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Apply preset" }) });
  await preset.getByLabel("Country").selectOption("SA");
  await preset.getByRole("button", { name: "Apply preset" }).click();
  await expect(page.getByText("Preset applied.")).toBeVisible();
  const vat = page.locator("form").filter({ has: page.getByLabel("VAT registration number") });
  await vat.getByLabel("Country").selectOption("SA");
  await vat.getByLabel(/^VAT registered/).check();
  await vat.getByLabel("VAT registration number").fill("310122393500003");
  await vat.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();

  // Seller details for e-invoices.
  await page.goto(`/o/${slug}/settings/zatca`);
  await expect(page.getByText(/Not yet validated against ZATCA/)).toBeVisible();
  await page.getByLabel("Legal name (as registered)").fill("Riyadh Grill Co");
  await page.getByLabel("Street").fill("King Fahd Road");
  await page.getByLabel("Building number").fill("12");
  await page.getByLabel("District").fill("Al Olaya");
  await page.getByLabel("City").fill("Riyadh");
  await page.getByLabel("Postal code").fill("12211");
  await page.getByLabel("Business category").fill("Restaurants");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Invalid value.")).toBeVisible();
  await page.getByLabel("Building number").fill("1234");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();

  // A branch, stock, an item at 115 incl. VAT, a register with an open shift.
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KIT");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("KABSA");
  await page.getByLabel("Name (English)").fill("Kabsa");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kabsa" })).toBeVisible();
  await page.goto(`/o/${slug}/menu`);
  await page.getByLabel("Name", { exact: true }).fill("Mains");
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByRole("link", { name: "New menu item" }).click();
  await page.getByLabel("Code", { exact: true }).fill("KABSA");
  await page.getByLabel("Name", { exact: true }).fill("Kabsa");
  await page.getByLabel("Category").selectOption({ label: "Mains" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page.getByLabel("Product", { exact: true }).selectOption({ label: "KABSA — Kabsa (each)" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "KABSA — Kabsa" })).toBeVisible();
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel(/^Price/).fill("115");
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /SAR\s?115\.00/ })).toBeVisible();
  await page.goto(`/o/${slug}/pos`);
  await page.getByLabel("Code", { exact: true }).fill("TILL1");
  await page.getByLabel("Name", { exact: true }).fill("Front till");
  await page.getByLabel("Stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add register" }).click();
  await page.getByLabel(/^Opening float/).fill("0");
  await page.getByRole("button", { name: "Open shift" }).click();
  await page.getByRole("link", { name: "Open till" }).click();

  // A card sale: the receipt is a simplified tax invoice with the Phase 1 QR.
  await page.getByRole("button", { name: /Kabsa/ }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: "Card approved" }).click();
  await expect(page.getByText(/Order POS-\d{4}-\d+ paid\./)).toBeVisible();
  await page.goto((await page.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!);
  await expect(page.getByText("Simplified tax invoice")).toBeVisible();
  await expect(page.getByText("VAT no. 310122393500003")).toBeVisible();
  const qr = page.getByTestId("zatca-qr");
  await expect(qr).toHaveAttribute("data-signed", "0");
  await expect(qr.locator("svg")).toBeVisible();

  // The register's unit: key and CSR made, waiting for the portal's OTP.
  await page.goto(`/o/${slug}/settings/zatca`);
  const unit = page.getByTestId("unit-TILL1");
  await expect(unit).toContainText("Not prepared");
  await unit.getByRole("button", { name: "Prepare unit" }).click();
  await expect(unit).toContainText("Prepared — waiting for OTP");
  await expect(unit.getByLabel("One-time password (OTP)")).toBeVisible();
  await context.close();
});
