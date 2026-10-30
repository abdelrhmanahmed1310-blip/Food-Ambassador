import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("categories and reorder: level → suggestion → draft order", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Planner",
    email: uniqueEmail("planner"),
    organization: "Planning Foods",
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

  // Category, then a product in it.
  await page.goto(`/o/${slug}/catalog/categories`);
  await page.getByLabel("Code", { exact: true }).fill("dry");
  await page.getByLabel("Name", { exact: true }).fill("Dry goods");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: "Dry goods" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("RICE");
  await page.getByLabel("Name (English)").fill("Rice");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Category").selectOption({ label: "DRY — Dry goods" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Rice" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products`);
  await expect(page.getByRole("cell", { name: "Dry goods" })).toBeVisible();

  // Supplier selling rice at a known price.
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("MILLS");
  await page.getByLabel("Name", { exact: true }).fill("Nile Mills");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Nile Mills" })).toBeVisible();
  await page.getByLabel("Product", { exact: true }).selectOption({ label: "RICE — Rice (kg)" });
  await page.getByLabel("Purchase unit").selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Last price").fill("42");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("cell", { name: /EGP\s?42\.00 \/ kg/ })).toBeVisible();

  // Reorder level 20–100 kg with no stock: suggest 100 kg from Nile Mills.
  await page.goto(`/o/${slug}/purchasing/reorder`);
  await page.getByLabel("Product", { exact: true }).selectOption({ label: "RICE — Rice (kg)" });
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Minimum").fill("20");
  await page.getByLabel("Maximum").fill("100");
  await page.getByRole("button", { name: "Save" }).click();
  const row = page.locator("tr", { hasText: "RICE" });
  await expect(row.getByText("100 kg").last()).toBeVisible();
  await expect(row.getByText("Nile Mills")).toBeVisible();
  await page.getByRole("button", { name: "Create draft orders" }).click();
  await expect(page.getByText(/Created draft order: PO-\d{4}-\d{6}/)).toBeVisible();
  await expect(row.getByText("Enough stock")).toBeVisible(); // now on order

  await page.goto(`/o/${slug}/purchasing/orders`);
  await page.getByRole("link", { name: /^PO-/ }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  await expect(page.getByText(/EGP\s?4,200\.00/).first()).toBeVisible();
  await context.close();
});
