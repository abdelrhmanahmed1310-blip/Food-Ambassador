import { expect, test, type Page } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

async function addIngredient(
  page: Page,
  item: string,
  quantity: string,
  unit: string,
  waste?: string,
) {
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add ingredient" }) });
  await form.getByLabel("Ingredient").selectOption({ label: item });
  await form.getByLabel("Net quantity").fill(quantity);
  await form.getByLabel("Unit", { exact: true }).selectOption({ label: unit });
  if (waste) await form.getByLabel("Waste %").fill(waste);
  await form.getByRole("button", { name: "Add ingredient" }).click();
  await expect(
    page.getByRole("cell", { name: `${quantity} ${unit.split(" ")[0]}` }).first(),
  ).toBeVisible();
}

test("recipes: preparation with waste, standard cost, activation, dish per portion", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Chef",
    email: uniqueEmail("chef"),
    organization: "Chef Foods",
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
  for (const [sku, name, unit] of [
    ["TOMATO", "Tomato", "kg — Kilogram"],
    ["OIL", "Olive oil", "l — Litre"],
  ]) {
    await page.goto(`/o/${slug}/catalog/products/new`);
    await page.getByLabel("SKU").fill(sku);
    await page.getByLabel("Name (English)").fill(name);
    await page.getByLabel("Base unit").selectOption({ label: unit });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  // Oil has no stock: a standard cost of 80 per litre.
  await page.getByLabel(/^Standard cost/).fill("80");
  await page.getByRole("button", { name: "Add standard cost" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?80\.00/ })).toBeVisible();
  // Tomatoes in stock at 20 per kg.
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("20");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // Sauce: 2 kg from 2.4 kg tomatoes (20 % trim) and 100 ml oil.
  await page.goto(`/o/${slug}/recipes`);
  await page.getByRole("link", { name: "New recipe" }).click();
  await page.getByLabel("Code").fill("SAUCE");
  await page.getByLabel("Type").selectOption("PREPARATION");
  await page.getByLabel("Name (English)").fill("Tomato sauce");
  await page.getByLabel("Yield quantity").fill("2");
  await page.getByLabel("Yield unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "SAUCE · Version 1" })).toBeVisible();
  await addIngredient(page, "TOMATO — Tomato (kg)", "2.4", "kg — Kilogram", "20");
  await addIngredient(page, "OIL — Olive oil (l)", "100", "ml — Millilitre");
  // 3 kg × 20 = 60, plus 0.1 l × 80 = 8.
  await expect(page.getByTestId("recipe-total")).toHaveText(/EGP\s?68\.00/);
  await expect(page.getByRole("cell", { name: "Standard cost" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("This version is locked.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add ingredient" })).toHaveCount(0);

  // Pasta: 4 portions, 500 g of sauce → 17 ÷ 4 = 4.25 per portion.
  await page.goto(`/o/${slug}/recipes/new`);
  await page.getByLabel("Code").fill("PASTA");
  await page.getByLabel("Type").selectOption("DISH");
  await page.getByLabel("Name (English)").fill("Pasta");
  await page.getByLabel("Yield quantity").fill("4");
  await page.getByLabel("Yield unit").selectOption({ label: "each — Each" });
  await page.getByLabel("Portions").fill("4");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "PASTA · Version 1" })).toBeVisible();
  await addIngredient(page, "Preparation: SAUCE — Tomato sauce", "500", "g — Gram");
  await expect(page.getByTestId("recipe-portion")).toHaveText(/EGP\s?4\.25/);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();

  // Cost history on the recipe page.
  await page.getByRole("link", { name: "All versions" }).click();
  await expect(page.getByRole("heading", { name: /^PASTA — Pasta/ })).toBeVisible();
  await expect(page.getByText("Version activated")).toBeVisible();
  await expect(page.getByRole("cell", { name: /EGP\s?4\.25/ }).first()).toBeVisible();
  await context.close();
});
