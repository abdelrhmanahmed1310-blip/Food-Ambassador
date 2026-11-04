import { expect, type Page } from "@playwright/test";
import { signUp, uniqueEmail } from "./helpers";

async function product(page: Page, slug: string, sku: string, name: string) {
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill(sku);
  await page.getByLabel("Name (English)").fill(name);
  await page.getByLabel("Base unit").selectOption({ label: "each — Each" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function menuItem(
  page: Page,
  slug: string,
  code: string,
  name: string,
  sku: string,
  price: string,
) {
  await page.goto(`/o/${slug}/menu/items/new`);
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Category").selectOption({ label: "Dining" });
  await page.getByLabel("Uses").selectOption("PRODUCT");
  await page
    .getByLabel("Product", { exact: true })
    .selectOption({ label: `${sku} — ${name} (each)` });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: `${code} — ${name}` })).toBeVisible();
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel(/^Price/).fill(price);
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: new RegExp(`EGP\\s?${price}\\.00`) })).toBeVisible();
}

/** A branch with a kitchen, cola (25) and soup (40), a register with an open shift, floor "Main hall" with T1. */
export async function setUpRestaurant(page: Page, label: string) {
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail(label),
    organization: "Table Foods",
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
  await product(page, slug, "COLA", "Cola");
  await product(page, slug, "SOUP", "Soup");
  await page.goto(`/o/${slug}/menu`);
  await page.getByLabel("Name", { exact: true }).fill("Dining");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("heading", { name: "Dining" })).toBeVisible();
  await menuItem(page, slug, "COLA", "Cola", "COLA", "25");
  await menuItem(page, slug, "SOUP", "Soup", "SOUP", "40");

  // A register with an open shift to take payments.
  await page.goto(`/o/${slug}/pos`);
  await page.getByLabel("Code", { exact: true }).fill("TILL1");
  await page.getByLabel("Name", { exact: true }).fill("Front till");
  await page.getByLabel("Stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add register" }).click();
  await page.getByLabel(/^Opening float/).fill("0");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // A floor with two tables.
  await page.goto(`/o/${slug}/pos/floors`);
  await page.getByLabel("Floor name").fill("Main hall");
  await page.getByLabel("Kitchen stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add floor" }).click();
  const floor = page.getByTestId("floor-Main hall");
  await floor.getByLabel("Table", { exact: true }).fill("T1");
  await floor.getByLabel("Seats").fill("4");
  await floor.getByRole("button", { name: "Add table" }).click();
  await expect(floor.getByText("T1")).toBeVisible();

  return slug;
}
