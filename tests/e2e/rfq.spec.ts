import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("request for quotation: compare two quotes, award with a reason, draft order created (ADR-092)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Buyer",
    email: uniqueEmail("rfq-owner"),
    organization: "Quote Foods",
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
  for (const [code, name] of [
    ["nile", "Nile Mills"],
    ["delta", "Delta Grain"],
  ]) {
    await page.goto(`/o/${slug}/suppliers/new`);
    await page.getByLabel("Code", { exact: true }).fill(code);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }

  await page.goto(`/o/${slug}/purchasing/rfqs/new`);
  await page.getByLabel("Title").fill("Flour for March");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /Flour for March/ })).toBeVisible();
  const rfqUrl = new URL(page.url()).pathname;

  await page.getByLabel("Product").selectOption({ label: "FLOUR — Flour (kg)" });
  await page.getByLabel("Quantity").fill("100");
  await page.getByLabel("Unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: "100 kg" })).toBeVisible();
  for (const label of ["NILE — Nile Mills", "DELTA — Delta Grain"]) {
    await page.getByLabel("Supplier").selectOption({ label });
    await page.getByRole("button", { name: "Ask supplier" }).click();
    await expect(page.getByRole("link", { name: label.split(" — ")[1] })).toBeVisible();
  }
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();

  const pdfHref = await page.getByRole("link", { name: "PDF" }).first().getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");

  for (const [label, price] of [
    ["NILE — Nile Mills", "10"],
    ["DELTA — Delta Grain", "9.5"],
  ]) {
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Record quotation" }) });
    await form.getByLabel("Supplier", { exact: true }).selectOption({ label });
    await form.getByLabel("Quotation date").fill("2026-11-03");
    await form.getByLabel(/Unit price per kg/).fill(price);
    await form.getByRole("button", { name: "Record quotation" }).click();
    await expect(page.getByText("Changes saved.").first()).toBeVisible();
  }
  await page.goto(rfqUrl);
  await expect(page.getByText("Lowest").first()).toBeVisible();

  // Award the dearer Nile Mills: a reason is required.
  const award = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Award and create orders" }) });
  await award.getByRole("radio", { name: /Nile Mills/ }).check();
  await award.getByRole("button", { name: "Award and create orders" }).click();
  await expect(page.getByText(/Say why this offer is chosen/)).toBeVisible();
  await award.getByLabel(/^Reason/).fill("Delta cannot deliver before March");
  await award.getByRole("button", { name: "Award and create orders" }).click();
  await expect(page.getByRole("link", { name: /From RFQ-/ })).toBeVisible();
  await expect(page.getByText("Nile Mills").first()).toBeVisible();

  await page.goto(rfqUrl);
  await expect(page.getByText("Awarded", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Delta cannot deliver before March")).toBeVisible();
  await context.close();
});
