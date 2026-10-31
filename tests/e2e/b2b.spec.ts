import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("B2B: order, deliver from stock at cost, invoice, collect, customer balance", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Sales Lead",
    email: uniqueEmail("b2b"),
    organization: "Kitchen Wholesale",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CK");
  await page.getByLabel("Name", { exact: true }).fill("Central kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Central kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("CKW");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen store" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("HUMMUS");
  await page.getByLabel("Name (English)").fill("Hummus");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Hummus" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "CKW — Kitchen store" });
  await page.getByLabel("Product").selectOption({ label: "HUMMUS — Hummus (kg)" });
  await page.getByLabel("Quantity").fill("20");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("15");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  await page.goto(`/o/${slug}/b2b/customers`);
  await page.getByLabel("Code").fill("HOTEL");
  await page.getByLabel("Name", { exact: true }).fill("Nile Hotel");
  await page.getByLabel(/^Payment terms/).fill("30");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("link", { name: "HOTEL" })).toBeVisible();

  await page.goto(`/o/${slug}/b2b/orders/new`);
  await page.getByLabel("Customer", { exact: true }).selectOption({ label: "HOTEL — Nile Hotel" });
  await page.getByLabel("Ship from").selectOption({ label: "CKW — Kitchen store" });
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-/ })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Product").selectOption({ label: "HUMMUS — Hummus (kg)" });
  await line.getByLabel("Quantity").fill("8");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await line.getByLabel("Net price").fill("40");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "8 kg" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();

  // 8 kg delivered at 15 = 120 cost; invoiced 8 × 40 = 320 (no VAT set up), margin 200.
  await page.getByRole("button", { name: "Deliver" }).click();
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Cost of goods: EGP\s?120\.00/)).toBeVisible();
  await page.getByRole("button", { name: "Invoice" }).click();
  await expect(page.getByRole("heading", { name: "Invoice", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId("sales-invoice-gross")).toHaveText(/320\.00/);
  await expect(page.getByTestId("margin")).toHaveText(/200\.00/);

  await page.goto(`/o/${slug}/b2b/customers`);
  await page.getByRole("link", { name: "HOTEL" }).click();
  const receipt = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record receipt" }) });
  await receipt.getByLabel(/^Amount/).fill("100");
  await receipt.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByRole("cell", { name: /220\.00/ })).toBeVisible();

  await page.goto(`/o/${slug}/b2b/balances`);
  await expect(page.getByTestId("customer-balance-HOTEL")).toContainText(/220\.00/);
  await context.close();
});
