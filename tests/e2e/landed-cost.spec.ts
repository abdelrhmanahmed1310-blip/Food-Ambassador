import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("landed cost: freight on a receipt raises the stock value", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Cost Accountant",
    email: uniqueEmail("landed"),
    organization: "Landed Foods",
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
  for (const [sku, name] of [
    ["RICE", "Rice"],
    ["LENTILS", "Lentils"],
  ]) {
    await page.goto(`/o/${slug}/catalog/products/new`);
    await page.getByLabel("SKU").fill(sku);
    await page.getByLabel("Name (English)").fill(name);
    await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("delta-grains");
  await page.getByLabel("Name", { exact: true }).fill("Delta Grains");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Delta Grains" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  for (const [product, qty, price] of [
    ["RICE — Rice (kg)", "100", "10"],
    ["LENTILS — Lentils (kg)", "50", "20"],
  ]) {
    await form.getByLabel("Product").selectOption({ label: product });
    await form.getByLabel("Quantity").fill(qty);
    await form.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
    await form.getByLabel("Unit price").fill(price);
    await form.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByRole("cell", { name: `${qty} kg` }).first()).toBeVisible();
  }
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();

  // Freight of 300 spread by value (1000 : 1000).
  const landed = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add landed cost" }) });
  await landed.getByLabel("Charge").selectOption("FREIGHT");
  await landed.getByLabel(/^Amount/).fill("300");
  await landed.getByLabel("Invoice / reference").fill("AWB-1001");
  await landed.getByRole("button", { name: "Add landed cost" }).click();
  await expect(page.getByRole("link", { name: /^LCA-/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "AWB-1001" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /EGP\s?150\.00/ }).first()).toBeVisible();
  // With landed costs the receipt can no longer be reversed.
  await expect(page.getByRole("heading", { name: "Reverse receipt" })).toHaveCount(0);

  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?2,300\.00/);
  await context.close();
});
