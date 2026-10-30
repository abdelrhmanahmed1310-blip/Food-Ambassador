import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("shipment: dispatch → in transit → receive with shortage", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Store Keeper",
    email: uniqueEmail("ship"),
    organization: "Shipping Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  for (const [code, name] of [
    ["MAIN", "Main store"],
    ["KITCH", "Kitchen"],
  ]) {
    await page.goto(`/o/${slug}/warehouses/new`);
    await page.getByLabel("Code", { exact: true }).fill(code);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("RICE");
  await page.getByLabel("Name (English)").fill("Rice");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Rice" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: "RICE — Rice (kg)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("20");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // Draft MAIN → KITCH with one line of 6 kg.
  await page.goto(`/o/${slug}/inventory/shipments`);
  await page.getByRole("link", { name: "New shipment" }).click();
  await page.getByLabel("From").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("To").selectOption({ label: "KITCH — Kitchen" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^SHP-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Stock").selectOption({ index: 1 });
  await line.getByLabel("Quantity").fill("6");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "6 kg" })).toBeVisible();

  // Dispatch: the 6 kg is in transit at MAIN, 4 kg remains available.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  await expect(page.getByText("In transit", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^DSP-/ })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "4 kg" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "6 kg" })).toBeVisible();

  // Receive 5 kg: the missing 1 kg needs a reason.
  await page.goto(`/o/${slug}/inventory/shipments?status=IN_TRANSIT`);
  await page.getByRole("link", { name: /^SHP-/ }).click();
  await expect(page.getByRole("heading", { name: /^SHP-/ })).toBeVisible();
  await page.getByLabel("Received (kg)").fill("5");
  await page.getByRole("button", { name: "Receive shipment" }).click();
  await expect(page.getByText("Choose a reason for the shortage.")).toBeVisible();
  await page.getByLabel("Shortage reason").selectOption("DAMAGED_IN_TRANSIT");
  await page.getByRole("button", { name: "Receive shipment" }).click();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^TRR-/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Damaged in transit" })).toBeVisible();

  // 4 kg at MAIN, 5 kg at KITCH, at the same average cost: 9 × 20 = 180.
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "4 kg" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "5 kg" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "In transit" })).toHaveCount(0);
  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?180\.00/);
  await context.close();
});
