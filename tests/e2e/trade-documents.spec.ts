import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("required trade documents hold back customs clearance until added (ADR-114)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Importer",
    email: uniqueEmail("trade-docs"),
    organization: "Paper Foods",
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
  for (const [sku, name] of [["RICE", "Rice"]]) {
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
  for (const [product, qty, price] of [["RICE — Rice (kg)", "100", "10"]]) {
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
  const poNumber = (await page.getByRole("heading", { name: /^PO-/ }).textContent())!.match(
    /PO-[\w-]+/,
  )![0];

  // Set-up: a commercial invoice is needed on every shipment.
  await page.goto(`/o/${slug}/trade/setup`);
  const typeForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add document type" }) });
  await typeForm.getByLabel("Code").fill("INV");
  await typeForm.getByLabel("Name", { exact: true }).fill("Commercial invoice");
  await typeForm.getByRole("button", { name: "Add document type" }).click();
  await expect(page.getByRole("cell", { name: "Commercial invoice" })).toBeVisible();
  const reqForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add requirement" }) });
  await reqForm.getByLabel("Document type").selectOption({ label: "INV — Commercial invoice" });
  await reqForm.getByLabel(/^Authority/).fill("Customs");
  await reqForm.getByRole("button", { name: "Add requirement" }).click();
  await expect(page.getByTestId("requirement-INV")).toBeVisible();

  await page.goto(`/o/${slug}/trade/shipments/new`);
  await page.getByLabel("Supplier").selectOption({ label: "DELTA-GRAINS — Delta Grains" });
  await page.getByLabel("Destination warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create shipment" }).click();
  await expect(page.getByRole("heading", { name: /^IMP-/ })).toBeVisible();
  await page
    .getByLabel("Approved order from this supplier to this warehouse")
    .selectOption({ label: poNumber });
  await page.getByRole("button", { name: "Link" }).click();
  await expect(page.getByTestId("check-INV").getByText("Missing")).toBeVisible();
  await page.getByRole("button", { name: "Mark as departed" }).click();
  await expect(page.getByText("In transit", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as arrived" }).click();
  await page.getByRole("button", { name: "Mark as cleared by customs" }).click();
  await expect(page.getByText(/Required documents are missing or expired/)).toBeVisible();

  const docForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add document" }) });
  await docForm.getByLabel("Document type").selectOption({ label: "INV — Commercial invoice" });
  await docForm.getByLabel(/^Number/).fill("CI-118");
  await docForm.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByTestId("check-INV").getByText("Held")).toBeVisible();
  await page.getByRole("button", { name: "Mark as cleared by customs" }).click();
  await expect(page.getByText("Cleared", { exact: true }).first()).toBeVisible();

  await page.goto(`/o/${slug}/trade/documents`);
  await expect(page.getByRole("link", { name: "INV — Commercial invoice" })).toBeVisible();
  await context.close();
});
