import { expect, test, type Page } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

async function createProduct(page: Page, slug: string, sku: string, name: string) {
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill(sku);
  await page.getByLabel("Name (English)").fill(name);
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function openingBalance(page: Page, slug: string, product: string, cost?: string) {
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: product });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  if (cost) await page.getByLabel("Unit cost").fill(cost);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();
}

test("stock value: average cost, cost missing, revaluation", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Cost Controller",
    email: uniqueEmail("value"),
    organization: "Value Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("MAIN");
  await page.getByLabel("Name", { exact: true }).fill("Main store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Main store" })).toBeVisible();

  await createProduct(page, slug, "RICE", "Rice");
  await createProduct(page, slug, "SALT", "Salt");

  // Rice opened at 20 per kg: value 200. The posted document shows the cost per base unit.
  await openingBalance(page, slug, "RICE — Rice (kg)", "20");
  await expect(page.getByRole("cell", { name: /EGP\s?200\.00/ })).toBeVisible();
  // Salt opened without a cost: valued at zero and flagged, never guessed.
  await openingBalance(page, slug, "SALT — Salt (kg)");

  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?200\.00/);
  await expect(page.getByText("1 item has stock without a known cost")).toBeVisible();
  const salt = page.locator("tr", { hasText: "SALT" });
  await expect(salt.getByText("Cost missing")).toBeVisible();

  // Revalue salt at 4.5 per kg.
  await salt.getByRole("link", { name: "Revalue" }).click();
  await expect(page.getByRole("heading", { name: "Revalue stock" })).toBeVisible();
  await page.getByLabel("New average cost").fill("4.5");
  await page.getByLabel("Reason").selectOption("MISSING_COST");
  await page.getByRole("button", { name: "Revalue" }).click();
  await expect(page.getByRole("heading", { name: /^RVL-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText(/EGP\s?45\.00/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reverse document" })).toHaveCount(0);

  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?245\.00/);
  await expect(page.getByText(/stock without a known cost/)).toHaveCount(0);

  // The dashboard shows the same figure, and the CSV export matches.
  await page.goto(`/o/${slug}/inventory`);
  await expect(page.getByText(/EGP\s?245\.00/)).toBeVisible();
  const csv = await page.request.get(`/o/${slug}/inventory/valuation/export`);
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body).toContain("MAIN,RICE,Rice,,10,kg,20,200,EGP,no");
  expect(body).toContain("MAIN,SALT,Salt,,10,kg,4.5,45,EGP,no");
  await context.close();
});
