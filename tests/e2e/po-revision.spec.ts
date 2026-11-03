import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("revise an approved purchase order and see what changed (ADR-093)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("revision-owner"),
    organization: "Revision Foods",
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

  // Revise: the supplier can only deliver 8 kg.
  await page.getByLabel(/Why is the order being revised/).fill("Supplier can only deliver 8 kg");
  await page.getByRole("button", { name: "Start revision" }).click();
  await expect(page.getByText(/Revision 1 is being prepared/)).toBeVisible();
  await page.getByText("Change", { exact: true }).click();
  const change = page
    .locator("form")
    .filter({ has: page.locator('input[name="uomId"][type="hidden"]') });
  await change.getByLabel(/^Quantity/).fill("8");
  await change.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?160\.00/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("po-revision")).toHaveText("Revision 1");
  await expect(page.getByText("Revision 0 → 1")).toBeVisible();
  await expect(page.getByText("Supplier can only deliver 8 kg")).toBeVisible();
  await expect(page.getByText(/FLOUR — Flour: quantity 10 → 8/)).toBeVisible();

  const pdf = await page.request.get(`${new URL(page.url()).pathname}/pdf`);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  await context.close();
});
