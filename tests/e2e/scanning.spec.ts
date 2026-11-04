import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

/** A keyboard-style scanner types the code and presses Enter (ADR-104). */
async function scan(page: import("@playwright/test").Page, label: RegExp, code: string) {
  const field = page.getByLabel(label);
  await field.fill(code);
  await field.press("Enter");
}

test("scan to look up, pick, label and load (ADR-104)", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Scanner User",
    email: uniqueEmail("scanning"),
    organization: "Scan Foods",
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
  await page.getByLabel("Warehouse").selectOption({ label: "CKW / PICK-1 — Pick face 1" });
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

  // Look up a location by scanning its code.
  await page.goto(`/o/${slug}/scan/lookup`);
  await scan(page, /^Code/, "pick-1");
  await expect(page.getByText("CKW / PICK-1 — Pick face 1")).toBeVisible();

  // Guided picking: a wrong product is refused, then the right one.
  await page.goto(`/o/${slug}/scan`);
  await page.getByRole("link", { name: /^PCK-/ }).click();
  await expect(page.getByTestId("pick-location")).toHaveText("PICK-1");
  await scan(page, /^Scan the location/, "PICK-2");
  await expect(page.getByText("Wrong location: expected PICK-1, scanned PICK-2.")).toBeVisible();
  await scan(page, /^Scan the location/, "PICK-1");
  await scan(page, /^Scan the product/, "BREAD");
  await expect(page.getByText(/^Wrong product: expected HUMMUS/)).toBeVisible();
  await scan(page, /^Scan the product/, "hummus");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Every line is scanned.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Submit pick" }).click();
  await expect(
    page.getByText(/Picked and moved to dispatch|not waiting to be picked/),
  ).toBeVisible();

  // Pack, print labels, then scan the unit onto a van.
  await page.goto(`/o/${slug}/inventory/picking`);
  await page.getByRole("link", { name: /^PCK-/ }).first().click();
  await expect(page.getByText("Picked", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Pack unit" }).click();
  await expect(page.getByText("Everything picked is packed.")).toBeVisible();
  await page.getByRole("link", { name: "Unit labels" }).click();
  const label = page.getByRole("img", { name: /^PKU-/ });
  await expect(label).toBeVisible();
  const unit = (await label.getAttribute("aria-label"))!;

  await page.goto(`/o/${slug}/inventory/loads`);
  await page.getByLabel(/^Vehicle/).fill("VAN 9");
  await page.getByRole("button", { name: "Create load" }).click();
  await expect(page.getByRole("heading", { name: /^LOD-/ })).toBeVisible();
  await page.getByLabel("Pick list").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add to load" }).click();
  await expect(page.getByText("0 of 1 units")).toBeVisible();
  const loadUrl = page.url();
  await page.goto(loadUrl.replace("/inventory/loads/", "/scan/loading/"));
  await scan(page, /^Scan a unit/, unit);
  await expect(page.getByTestId("load-progress")).toHaveText("1 of 1 units loaded");
  await context.close();
});
