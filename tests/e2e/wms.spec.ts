import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("receive into the dock, inspect out of quarantine, put away by rule (ADR-101)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Store Lead",
    email: uniqueEmail("wms"),
    organization: "Cold Store Foods",
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
  const warehouseUrl = page.url();
  const addLocation = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add location" }) });
  for (const [code, name, use] of [
    ["DOCK", "Receiving dock", "RECEIVING"],
    ["CH-A", "Chiller A", "STORAGE"],
  ]) {
    await addLocation.getByLabel("Code", { exact: true }).fill(code);
    await addLocation.getByLabel("Name", { exact: true }).fill(name);
    await addLocation.getByLabel("Temperature zone").selectOption("CHILLED");
    await addLocation.getByLabel("Use").selectOption(use);
    await addLocation.getByRole("button", { name: "Add location" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }

  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("MILK");
  await page.getByLabel("Name (English)").fill("Milk");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Lot tracking").selectOption("LOT");
  await page.getByLabel("Storage").selectOption("CHILLED");
  await page.getByLabel(/^Inspect on receipt/).check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Milk" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("dairy");
  await page.getByLabel("Name", { exact: true }).fill("Dairy Co");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Dairy Co" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const line = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await line.getByLabel("Product").selectOption({ label: "MILK — Milk (kg)" });
  await line.getByLabel("Quantity").fill("50");
  await line.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await line.getByLabel("Unit price").fill("3");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "50 kg" }).first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByLabel("Lot").fill("M-2611");
  await page.getByLabel(/^Temp/).fill("4");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();

  // The milk waits in quarantine: inspect it, accept 45 kg, reject 5.
  await page.goto(`/o/${slug}/inventory/inspections`);
  await page.getByLabel("Packaging intact").selectOption("no");
  await page.getByLabel("Labelling correct").selectOption("yes");
  await page.getByLabel("Condition acceptable").selectOption("yes");
  await page.getByLabel(/^Accepted/).fill("45");
  await page.getByLabel(/^Reason for rejecting/).fill("Five cartons crushed");
  await page.getByLabel(/^Note/).fill("Crushed cartons rejected, the rest intact");
  await page.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText("Partly accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing is waiting for inspection.")).toBeVisible();

  // Put-away: a rule sends chilled goods to Chiller A.
  await page.goto(warehouseUrl);
  await page.getByRole("link", { name: "Put-away" }).click();
  await expect(page.getByRole("heading", { name: "Put-away — MAIN" })).toBeVisible();
  await expect(page.getByText("No rule — choose a place")).toBeVisible();
  const rule = page.locator("form").filter({ has: page.getByRole("button", { name: "Add rule" }) });
  await rule.getByLabel(/^Priority/).fill("10");
  await rule.getByLabel("Storage").selectOption("CHILLED");
  await rule.getByLabel("Location").selectOption({ label: "CH-A — Chiller A · Chilled" });
  await rule.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByText("By rule")).toBeVisible();
  await expect(page.getByLabel(/^Quantity/)).toHaveValue("45");
  await page.getByRole("button", { name: "Put away" }).click();
  await expect(page.getByText("Nothing is waiting to be put away.")).toBeVisible();
  await context.close();
});
