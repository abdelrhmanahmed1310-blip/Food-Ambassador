import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("plan a pick list for a sales order, pick to dispatch, deliver the picked stock (ADR-102)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Dispatch Lead",
    email: uniqueEmail("picking"),
    organization: "Pick Foods",
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
  const addLocation = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add location" }) });
  for (const [code, name, use] of [
    ["PICK-1", "Pick face 1", "PICKING"],
    ["DSP-A", "Dispatch bay", "DISPATCH"],
  ]) {
    await addLocation.getByLabel("Code", { exact: true }).fill(code);
    await addLocation.getByLabel("Name", { exact: true }).fill(name);
    await addLocation.getByLabel("Temperature zone").selectOption("AMBIENT");
    await addLocation.getByLabel("Use").selectOption(use);
    await addLocation.getByRole("button", { name: "Add location" }).click();
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  }
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
  await expect(page.getByRole("button", { name: "Plan pick list" })).toBeVisible();

  await page.getByRole("button", { name: "Plan pick list" }).click();
  await expect(page.getByRole("heading", { name: /^PCK-.* — SO-/ })).toBeVisible();
  await expect(page.getByText("Planned", { exact: true }).first()).toBeVisible();
  const sheet = await page.getByRole("link", { name: "Pick sheet (PDF)" }).getAttribute("href");
  const pdf = await page.request.get(sheet!);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");

  await expect(page.getByLabel(/^Picked/)).toHaveValue("8");
  await page.getByRole("button", { name: "Confirm pick" }).click();
  await expect(page.getByText("Picked", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "DSP-A" })).toBeVisible();
  await page.getByRole("button", { name: "Deliver picked stock" }).click();
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: /^SO-/ }).first().click();
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await context.close();
});
