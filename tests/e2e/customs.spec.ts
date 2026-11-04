import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("customs declaration, duty and freight spread over the shipment's receipt (ADR-115)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Importer",
    email: uniqueEmail("customs"),
    organization: "Customs Foods",
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

  await page.goto(`/o/${slug}/trade/shipments/new`);
  await page.getByLabel("Supplier").selectOption({ label: "DELTA-GRAINS — Delta Grains" });
  await page.getByLabel("Destination warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel(/^Incoterm/).selectOption("CIF");
  await page.getByLabel(/^Bill of lading/).fill("MAEU123456789");
  await page.getByRole("button", { name: "Create shipment" }).click();
  await expect(page.getByRole("heading", { name: /^IMP-.* — Delta Grains$/ })).toBeVisible();

  await page
    .getByLabel("Approved order from this supplier to this warehouse")
    .selectOption({ label: poNumber });
  await page.getByRole("button", { name: "Link" }).click();
  await expect(page.getByRole("link", { name: poNumber })).toBeVisible();

  const container = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add container" }) });
  await container.getByLabel(/^Container number/).fill("CSQU3054384");
  await container.getByRole("button", { name: "Add container" }).click();
  await expect(container.getByText(/check digit/)).toBeVisible();
  await container.getByLabel(/^Container number/).fill("CSQU3054383");
  await container.getByLabel("Type").selectOption("REEFER_40");
  await container.getByLabel(/^Set point/).fill("-18");
  await container.getByRole("button", { name: "Add container" }).click();
  await expect(page.getByRole("cell", { name: "CSQU3054383" })).toBeVisible();

  await page.getByRole("button", { name: "Mark as departed" }).click();
  await expect(page.getByText("In transit", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as arrived" }).click();
  await expect(page.getByText("Arrived", { exact: true }).first()).toBeVisible();

  const shipmentUrl = page.url();
  await page.getByRole("link", { name: poNumber }).click();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-/ })).toBeVisible();
  const grn = (await page.getByRole("heading", { name: /^GRN-/ }).textContent())!.match(
    /GRN-[\w-]+/,
  )![0];
  await page.goto(shipmentUrl);
  await page.getByLabel("Posted receipt of one of these orders").selectOption({ label: grn });
  await page.getByRole("button", { name: "Link" }).click();
  await expect(page.getByRole("link", { name: grn })).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible();

  // 100 kg rice at 10: goods 1 000.
  const decl = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Record declaration" }) });
  await decl.getByLabel(/^Declaration number/).fill("DCL-2026-77");
  await decl.getByLabel("Declared on").fill(new Date().toISOString().slice(0, 10));
  await decl.getByLabel(/^Duty assessed/).fill("50");
  await decl.getByLabel(/^Import VAT/).fill("157.5");
  await decl.getByRole("button", { name: "Record declaration" }).click();
  await expect(page.getByTestId("customs-DCL-2026-77").getByText("Not all posted")).toBeVisible();

  const charge = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add landed cost" }) });
  await charge.getByLabel("Charge").selectOption("CUSTOMS_DUTY");
  await charge.getByLabel("Amount").fill("50");
  await charge.getByLabel(/^Customs declaration/).selectOption({ label: "DCL-2026-77" });
  await charge.getByRole("button", { name: "Add landed cost" }).click();
  await expect(page.getByTestId("charge-CUSTOMS_DUTY")).toBeVisible();
  await expect(page.getByTestId("customs-DCL-2026-77").getByText("Not all posted")).toHaveCount(0);
  await charge.getByLabel("Charge").selectOption("FREIGHT");
  await charge.getByLabel("Amount").fill("100");
  await charge.getByRole("button", { name: "Add landed cost" }).click();
  await expect(page.getByTestId("charge-FREIGHT")).toBeVisible();
  // 1 000 goods + 150 charges = 1 150; 15 % on top.
  await expect(page.getByTestId("shipment-costs").getByText(/1,150\.00/)).toBeVisible();
  await expect(page.getByTestId("shipment-costs").getByText("15.0%")).toBeVisible();
  await context.close();
});
