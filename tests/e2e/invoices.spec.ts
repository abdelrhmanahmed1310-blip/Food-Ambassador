import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("supplier invoice: 3-way match against the receipt, total check, posting and input VAT", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Payables Clerk",
    email: uniqueEmail("invoice"),
    organization: "Nile Kitchens",
  });
  await page.goto(`/o/${slug}/settings/tax`);
  const preset = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Apply preset" }) });
  await preset.getByLabel("Country").selectOption("EG");
  await preset.getByRole("button", { name: "Apply preset" }).click();
  await expect(page.getByText("Preset applied.")).toBeVisible();

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
  await page.getByLabel("SKU").fill("RICE");
  await page.getByLabel("Name (English)").fill("Rice");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Rice" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("delta");
  await page.getByLabel("Name", { exact: true }).fill("Delta Grains");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Delta Grains" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await form.getByLabel("Product").selectOption({ label: "RICE — Rice (kg)" });
  await form.getByLabel("Quantity").fill("10");
  await form.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await form.getByLabel("Unit price").fill("10");
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "10 kg" }).first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();

  // The invoice total as printed is wrong at first.
  await page.goto(`/o/${slug}/purchasing/invoices`);
  await page.getByRole("link", { name: "New supplier invoice" }).click();
  await page
    .getByLabel("Supplier", { exact: true })
    .selectOption({ label: "DELTA — Delta Grains" });
  await page.getByLabel("Supplier invoice no.").fill("DG-5501");
  await page.getByLabel("Invoice date").fill("2026-10-20");
  await page.getByLabel("Total on the invoice").fill("120");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { name: /^PI-/ })).toBeVisible();
  await page.getByRole("button", { name: "Add to invoice" }).click();
  // 10 kg × 10 + 14 % VAT = 114.
  await expect(page.getByTestId("invoice-line-1")).toContainText("Matched");
  await expect(page.getByText(/does not equal the lines/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Post invoice" })).toHaveCount(0);
  await expect(page.getByText("Nothing received from this supplier is waiting")).toBeVisible();

  const header = page.locator("form").filter({ has: page.getByLabel("Total on the invoice") });
  await header.getByLabel("Total on the invoice").fill("114");
  await header.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByText("Posted", { exact: true })).toBeVisible();

  await page.goto(`/o/${slug}/sales/vat?from=2026-10-01&to=2026-10-31`);
  await expect(page.getByTestId("vat-in-STD")).toContainText("14 %");
  await expect(page.getByTestId("vat-in-STD")).toContainText(/14\.00/);
  // Not VAT registered: the VAT is a cost, not reclaimable.
  await expect(page.getByText(/not VAT registered/)).toBeVisible();
  await context.close();
});
