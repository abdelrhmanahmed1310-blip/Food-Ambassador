import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("return part of a receipt to the supplier (ADR-094)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("return-owner"),
    organization: "Return Foods",
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
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: /^GRN-|^RCV-|Receipt/ })).toBeVisible();

  // From the receipt: return 4 kg.
  await page.getByRole("link", { name: "Return goods" }).click();
  await page.getByLabel("Reason").selectOption({ label: "Quality" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^RTS-/ })).toBeVisible();
  await expect(page.getByText("10 kg left to return")).toBeVisible();
  const line = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add", exact: true }) });
  await line.getByLabel(/^Quantity/).fill("4");
  await line.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?80\.00/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Post return" }).click();
  await expect(page.getByText("Awaiting credit", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^SRT-/ })).toBeVisible();

  const pdf = await page.request.get(`${new URL(page.url()).pathname}/pdf`);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");

  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByText("6 kg").first()).toBeVisible();
  await context.close();
});
