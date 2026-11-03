import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("spend and price variance reports from what was received (ADR-095)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("spend-owner"),
    organization: "Spend Foods",
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
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("FLOUR");
  await page.getByLabel("Name (English)").fill("Flour");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Flour" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("nile");
  await page.getByLabel("Name", { exact: true }).fill("Nile Mills");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Nile Mills" })).toBeVisible();

  await page.goto(`/o/${slug}/purchasing/orders/new`);
  await page.getByLabel("Supplier").selectOption({ label: "NILE — Nile Mills" });
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await add.getByLabel("Product").selectOption({ label: "FLOUR — Flour (kg)" });
  await add.getByLabel("Quantity").fill("10");
  await add.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await add.getByLabel("Unit price").fill("20");
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?200\.00/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByLabel("Received (kg)").fill("10");
  await page.getByLabel(/^Charged/).fill("22");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-|^RCV-|Receipt/ })).toBeVisible();

  // Spend: 10 kg at 22 = 220.
  await page.goto(`/o/${slug}/reports/spend`);
  await expect(page.getByRole("heading", { name: "Spend" })).toBeVisible();
  await expect(page.getByTestId("spend-totals")).toContainText(/EGP\s?220\.00/);
  await expect(page.getByRole("link", { name: "Nile Mills" })).toBeVisible();
  const csv = await page.request.get(`/o/${slug}/reports/spend/export`);
  expect(await csv.text()).toContain("NILE,Nile Mills,220.00,0.00,220.00,100.00,1,20.00,EGP");

  // Price variance: ordered 20, charged 22 → 20 over.
  await page.goto(`/o/${slug}/reports/price-variance`);
  await expect(page.getByTestId("ppv-totals")).toContainText(/EGP\s?20\.00/);
  await expect(page.getByRole("cell", { name: /EGP\s?22\.00/ }).first()).toBeVisible();
  await context.close();
});
