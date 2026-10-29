import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

test("purchasing journey: supplier → order → receive with rejection → over-receipt refused → close", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Buyer",
    email: uniqueEmail("buyer"),
    organization: "Buying Foods",
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

  for (const [sku, name, unit, chilled] of [
    ["FLOUR", "Flour", "kg — Kilogram", false],
    ["MILK", "Milk", "l — Litre", true],
  ] as const) {
    await page.goto(`/o/${slug}/catalog/products/new`);
    await page.getByLabel("SKU").fill(sku);
    await page.getByLabel("Name (English)").fill(name);
    await page.getByLabel("Base unit").selectOption({ label: unit });
    if (chilled) {
      await page.getByLabel("Lot tracking").selectOption("LOT_AND_EXPIRY");
      await page.getByLabel("Storage").selectOption("CHILLED");
    }
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }

  // Supplier.
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("nile-mills");
  await page.getByLabel("Name", { exact: true }).fill("Nile Mills");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Nile Mills" })).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();

  // Order: two lines, auto-approved on submit (no approval limit set).
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Expected delivery").fill(future);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-\d{4}-\d{6}$/ })).toBeVisible();
  const addLine = async (product: string, qty: string, unit: string, price: string) => {
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Add line" }) });
    await form.getByLabel("Product").selectOption({ label: product });
    await form.getByLabel("Quantity").fill(qty);
    await form.getByLabel("Unit", { exact: true }).selectOption({ label: unit });
    await form.getByLabel("Unit price").fill(price);
    await form.getByRole("button", { name: "Add line" }).click();
  };
  await addLine("FLOUR — Flour (kg)", "10", "kg — Kilogram", "20");
  await expect(page.getByRole("cell", { name: /EGP\s?200\.00/ })).toBeVisible();
  await addLine("MILK — Milk (l)", "20", "l — Litre", "30");
  await expect(page.getByText(/EGP\s?800\.00/).first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();

  // Receive: 6 kg flour of which 1 damaged; all milk, chilled, with lot, expiry and temperature.
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await expect(page.getByRole("heading", { name: /^Receive delivery — PO-/ })).toBeVisible();
  await page.getByLabel("Received (kg)").fill("6");
  await page.getByLabel("Rejected (kg)").fill("1");
  await page.getByLabel("Rejection reason").first().selectOption("DAMAGED");
  await page.getByRole("button", { name: "Post receipt" }).click();
  // Chilled goods need a temperature; the error points at that field.
  await expect(page.getByText("Record the temperature of chilled or frozen goods.")).toBeVisible();
  await page.getByLabel("Lot").fill("m-2001");
  await page.getByLabel("Expiry").fill(future);
  await page.getByLabel("Temp. °C").nth(1).fill("4");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText("Damaged")).toBeVisible();

  // Stock and value: 5 kg flour at 20, 20 l milk at 30.
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "5 kg" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "20 l" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/valuation`);
  await expect(page.getByTestId("total-value")).toHaveText(/EGP\s?700\.00/);

  // Over-receipt beyond the (0 %) tolerance is refused; then the order is short-closed.
  await page.goto(`/o/${slug}/purchasing/orders`);
  await page.getByRole("link", { name: /^PO-/ }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  await expect(page.getByText("Partly received")).toBeVisible();
  await page.getByRole("link", { name: "Receive delivery" }).click();
  await page.getByLabel("Received (kg)").fill("6");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(
    page.getByText("More than ordered. At most 5 more can be accepted on this line."),
  ).toBeVisible();
  await page.goto(`/o/${slug}/purchasing/orders`);
  await page.getByRole("link", { name: /^PO-/ }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const close = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Close order" }) });
  await close.getByLabel("Reason").fill("Rest not needed");
  await close.getByRole("button", { name: "Close order" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Receive delivery" })).toHaveCount(0);

  // Supplier scorecard from the real receipt.
  await page.goto(`/o/${slug}/suppliers`);
  await page.getByRole("link", { name: "Nile Mills" }).click();
  await expect(page.getByText("Supplier performance")).toBeVisible();
  await context.close();
});
