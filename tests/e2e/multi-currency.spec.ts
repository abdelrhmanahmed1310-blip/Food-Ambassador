import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("a USD supplier: rate entered, order and receipt in USD, stock valued in EGP", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("fx"),
    organization: "Import Foods",
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
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
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("SAFFRON");
  await page.getByLabel("Name (English)").fill("Saffron");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Saffron" })).toBeVisible();

  // Exchange rate: 1 USD = 49 EGP today.
  await page.goto(`/o/${slug}/purchasing/exchange-rates`);
  await expect(page.getByTestId("fx-latest-USD")).toContainText("No rate yet");
  await page.getByLabel("Currency", { exact: true }).selectOption("USD");
  await page.getByLabel("Rate date").fill(today);
  await page.getByLabel(/^Rate \(EGP per unit\)/).fill("49");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("fx-latest-USD")).toContainText("49");

  // A supplier invoicing in USD.
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("spice-co");
  await page.getByLabel("Name", { exact: true }).fill("Spice Co");
  await page.getByLabel("Currency").selectOption("USD");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Spice Co" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await form.getByLabel("Product").selectOption({ label: "SAFFRON — Saffron (kg)" });
  await form.getByLabel("Quantity").fill("2");
  await form.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await form.getByLabel("Unit price").fill("12.5");
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: /\$25\.00|USD\s?25\.00/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("fx-rate")).toContainText("1 USD = 49 EGP");
  await expect(page.getByTestId("fx-base-amount")).toHaveText(/EGP\s?1,225\.00/);

  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByLabel("Received (kg)").fill("2");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();
  await expect(page.getByTestId("fx-rate")).toContainText("1 USD = 49 EGP");

  // Stock is valued in the base currency: 2 kg × 12.5 USD × 49.
  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?1,225\.00/);
  await context.close();
});
