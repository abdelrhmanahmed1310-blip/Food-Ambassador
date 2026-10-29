import { expect, test, type Page } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

async function createBranchAndWarehouses(page: Page, slug: string) {
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  for (const [code, name] of [
    ["MAIN", "Main store"],
    ["KIT", "Kitchen store"],
  ]) {
    await page.goto(`/o/${slug}/warehouses/new`);
    await page.getByLabel("Code", { exact: true }).fill(code);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
}

test("inventory journey: product → opening balance → transfer → quarantine → reversal → count", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Stock Keeper",
    email: uniqueEmail("stock"),
    organization: "Stock Foods",
  });
  await createBranchAndWarehouses(page, slug);

  // Product: milk, stocked in litres, lots with expiry.
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("milk-1l");
  await page.getByLabel("Name (English)").fill("Fresh milk");
  await page.getByLabel("Name (Arabic)").fill("حليب طازج");
  await page.getByLabel("Base unit").selectOption({ label: "l — Litre" });
  await page.getByLabel("Lot tracking").selectOption("LOT_AND_EXPIRY");
  await page.getByLabel("Storage").selectOption("CHILLED");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Fresh milk" })).toBeVisible();

  // Opening balance entered in millilitres is stored in litres.
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: "MILK-1L — Fresh milk (l)" });
  await page.getByLabel("Lot code").fill("m-0001");
  await page.getByLabel("Expiry date").fill(future);
  await page.getByLabel("Quantity").fill("50000");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "ml — Millilitre" });
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "+50 l" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "50,000 ml" })).toBeVisible();

  // A lot-tracked product without a lot is rejected with a field error.
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: "MILK-1L — Fresh milk (l)" });
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "l — Litre" });
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByText("This product is lot-tracked: enter a lot.")).toBeVisible();

  // Stock list → stock line → transfer 20 l to the kitchen.
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "50 l" })).toBeVisible();
  await page.getByRole("link", { name: "Fresh milk" }).click();
  const transfer = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Transfer" }) });
  await transfer.getByLabel("Destination").selectOption({ label: "KIT — Kitchen store" });
  await transfer.getByLabel("Quantity").fill("20");
  await transfer.getByRole("button", { name: "Transfer" }).click();
  await expect(page.getByRole("heading", { name: /^TRF-/ })).toBeVisible();
  await expect(
    page.locator("tr", { hasText: "Transfer out" }).getByRole("cell", { name: "-20 l" }).first(),
  ).toBeVisible();
  await expect(
    page.locator("tr", { hasText: "Transfer in" }).getByRole("cell", { name: "+20 l" }),
  ).toBeVisible();

  // Quarantine 5 l in the kitchen; availability drops accordingly.
  await page.goto(`/o/${slug}/inventory/stock`);
  await page.locator("tr", { hasText: "KIT" }).getByRole("link", { name: "Fresh milk" }).click();
  const status = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Change status" }) });
  await status.getByLabel("To").selectOption("QUARANTINE");
  await status.getByLabel("Quantity").fill("5");
  await status.getByLabel("Reason").selectOption("TEMPERATURE_EXCURSION");
  await status.getByRole("button", { name: "Change status" }).click();
  await expect(page.getByRole("heading", { name: /^QS-/ })).toBeVisible();

  // Over-issue is refused with the available quantity.
  await page.goto(`/o/${slug}/inventory/stock?status=AVAILABLE`);
  await page.locator("tr", { hasText: "KIT" }).getByRole("link", { name: "Fresh milk" }).click();
  const writeOff = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Write off" }) });
  await writeOff.getByLabel("Quantity").fill("16");
  await writeOff.getByLabel("Reason").selectOption("SPOILED");
  await writeOff.getByRole("button", { name: "Write off" }).click();
  await expect(writeOff.getByRole("alert")).toHaveText(
    "Not enough available stock (available: 15).",
  );

  // Reverse the quarantine: the 5 l return to available stock.
  await page.goto(`/o/${slug}/inventory/documents`);
  await page.getByRole("link", { name: /^QS-/ }).click();
  await page.getByLabel("Reason").selectOption("ENTERED_IN_ERROR");
  await page.getByRole("button", { name: "Reverse document" }).click();
  await expect(page.getByRole("heading", { name: /^REV-/ })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/documents`);
  await expect(page.getByText(/Reversed by REV-/)).toBeVisible();

  // Stock count in the kitchen: counted 19 of 20 → -1 adjustment.
  await page.goto(`/o/${slug}/inventory/counts`);
  await page.getByLabel("Warehouse").selectOption({ label: "KIT — Kitchen store" });
  await page.getByRole("button", { name: "New count" }).click();
  await expect(page.getByRole("heading", { name: /^SC-/ })).toBeVisible();
  await page.getByLabel(/Counted — MILK-1L/).fill("19");
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByRole("cell", { name: "-1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve and post" }).click();
  await expect(page.getByText(/Posted as/)).toBeVisible();
  await page.getByRole("link", { name: /^CNT-/ }).click();
  await expect(
    page.locator("tr", { hasText: "Count adjustment" }).getByRole("cell", { name: "-1 l" }).first(),
  ).toBeVisible();

  // Dashboard and the Arabic stock view.
  await page.goto(`/o/${slug}/inventory`);
  await expect(page.getByRole("link", { name: /Products in stock\s*1/ })).toBeVisible();
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("link", { name: "حليب طازج" }).first()).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await context.close();
});

test("CSV import validates every row, then imports; stock exports as CSV", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Importer",
    email: uniqueEmail("import"),
    organization: "Import Foods",
  });
  await createBranchAndWarehouses(page, slug);
  await page.goto(`/o/${slug}/catalog/import`);

  const products = page.locator("section", { hasText: "Import products" });
  await products.getByLabel("CSV file").setInputFiles({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "sku,name_en,name_ar,type,base_unit\nRICE,Rice,أرز,RAW_MATERIAL,kg\nOIL,Oil,,RAW_MATERIAL,gallon\n",
    ),
  });
  await products.getByRole("button", { name: "Validate and import" }).click();
  await expect(products.getByRole("alert")).toContainText("Nothing was imported: 1 problem found.");
  await expect(products.getByRole("cell", { name: "Unknown unit code." })).toBeVisible();

  await products.getByLabel("CSV file").setInputFiles({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "sku,name_en,name_ar,type,base_unit\nRICE,Rice,أرز,RAW_MATERIAL,kg\nOIL,Oil,,RAW_MATERIAL,l\n",
    ),
  });
  await products.getByRole("button", { name: "Validate and import" }).click();
  await expect(products.getByRole("status")).toContainText("2 rows imported.");

  const opening = page.locator("section", { hasText: "Import opening balances" });
  const file =
    "warehouse_code,location_code,sku,lot_code,expires_on,quantity,unit,unit_cost\nMAIN,,RICE,,,2500,g,0.04\nKIT,,OIL,,,3,l,\n";
  await opening
    .getByLabel("CSV file")
    .setInputFiles({ name: "opening.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
  await opening.getByRole("button", { name: "Validate and import" }).click();
  await expect(opening.getByRole("status")).toContainText("2 rows imported.");
  // The same file again is refused instead of doubling stock.
  await opening
    .getByLabel("CSV file")
    .setInputFiles({ name: "opening.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
  await opening.getByRole("button", { name: "Validate and import" }).click();
  await expect(opening.getByRole("alert")).toHaveText("This file was already imported.");

  const response = await page.request.get(`/o/${slug}/inventory/stock/export`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  const csv = await response.text();
  expect(csv).toContain("MAIN,,RICE,Rice,أرز,,,AVAILABLE,2.5,2.5,kg,NONE");
  expect(csv).toContain("KIT,,OIL,Oil,,,,AVAILABLE,3,3,l,NONE");
  await context.close();
});

test("inventory exports and pages are tenant-scoped", async ({ browser }) => {
  const a = await newClient(browser);
  const b = await newClient(browser);
  await signUp(a.page, { name: "A", email: uniqueEmail("inv-a"), organization: "Inv A" });
  const slugB = await signUp(b.page, {
    name: "B",
    email: uniqueEmail("inv-b"),
    organization: "Inv B",
  });
  expect((await a.page.request.get(`/o/${slugB}/inventory/stock/export`)).status()).toBe(404);
  expect((await a.page.goto(`/o/${slugB}/inventory`))?.status()).toBe(404);
  const anonymous = await browser.newContext();
  expect(
    (
      await anonymous.request.get(`/o/${slugB}/inventory/stock/export`, { maxRedirects: 0 })
    ).status(),
  ).toBeGreaterThanOrEqual(300);
  await anonymous.close();
  await a.context.close();
  await b.context.close();
});
