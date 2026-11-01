import { expect, type Page } from "@playwright/test";
import { signUp, uniqueEmail } from "./helpers";

/** Branch, kitchen, a cola sold from stock at 25 on dine-in, a register with an open shift (float 100). */
export async function openTill(page: Page, label: string) {
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail(label),
    organization: "Till Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KIT");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("COLA");
  await page.getByLabel("Name (English)").fill("Cola can");
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cola can" })).toBeVisible();

  await page.goto(`/o/${slug}/menu`);
  await page.getByLabel("Name", { exact: true }).fill("Drinks");
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByRole("link", { name: "New menu item" }).click();
  await page.getByLabel("Code", { exact: true }).fill("COLA");
  await page.getByLabel("Name", { exact: true }).fill("Cola");
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: "COLA — Cola can (each)" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "COLA — Cola" })).toBeVisible();
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel(/^Price/).fill("25");
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?25\.00/ })).toBeVisible();

  // A register at Cairo using the kitchen's stock; a shift with a 100 float.
  await page.goto(`/o/${slug}/pos`);
  await expect(page.getByText("No registers yet.")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill("TILL1");
  await page.getByLabel("Name", { exact: true }).fill("Front till");
  await page.getByLabel("Stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add register" }).click();
  await expect(page.getByRole("heading", { name: "TILL1 — Front till" })).toBeVisible();
  await page.getByLabel(/^Opening float/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();
  return slug;
}
