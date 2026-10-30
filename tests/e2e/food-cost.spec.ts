import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("food cost: price, target, simulator, ingredient replacement, recipe card", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("menu"),
    organization: "Menu Foods",
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
  for (const [sku, name] of [
    ["TOMATO", "Tomato"],
    ["CHERRY", "Cherry tomato"],
  ]) {
    await page.goto(`/o/${slug}/catalog/products/new`);
    await page.getByLabel("SKU").fill(sku);
    await page.getByLabel("Name (English)").fill(name);
    await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  // Cherry tomatoes: standard cost 40 / kg.
  await page.getByLabel(/^Standard cost/).fill("40");
  await page.getByRole("button", { name: "Add standard cost" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?40\.00/ })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "MAIN — Main store" });
  await page.getByLabel("Product").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("20");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // Salad: one portion with 0.5 kg tomatoes = 10.00; method on the card.
  await page.goto(`/o/${slug}/recipes/new`);
  await page.getByLabel("Code").fill("SALAD");
  await page.getByLabel("Type").selectOption("DISH");
  await page.getByLabel("Name (English)").fill("Tomato salad");
  await page.getByLabel("Yield quantity").fill("1");
  await page.getByLabel("Yield unit").selectOption({ label: "each — Each" });
  await page.getByLabel("Portions").fill("1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "SALAD · Version 1" })).toBeVisible();
  const ing = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add ingredient" }) });
  await ing.getByLabel("Ingredient").selectOption({ label: "TOMATO — Tomato (kg)" });
  await ing.getByLabel("Net quantity").fill("0.5");
  await ing.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await ing.getByRole("button", { name: "Add ingredient" }).click();
  await expect(page.getByTestId("recipe-portion")).toHaveText(/EGP\s?10\.00/);
  await page.getByLabel("Method").fill("Slice and dress.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Method")).toHaveValue("Slice and dress.");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Recipe card" }).click();
  await expect(page.getByRole("heading", { name: "Tomato salad" })).toBeVisible();
  await expect(page.getByText("Slice and dress.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();

  // Price 25 against a 30 % target: 40 % food cost, needs 33.34.
  await page.goto(`/o/${slug}/recipes`);
  await page.getByRole("link", { name: "SALAD" }).click();
  await page.getByLabel(/^Selling price/).fill("25");
  await page.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?25\.00/ })).toBeVisible();
  await page.goto(`/o/${slug}/recipes/food-cost`);
  await expect(page.getByTestId("dish-SALAD")).toContainText("No target");
  await page.getByLabel("Target food cost %").fill("30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("dish-SALAD")).toContainText("Above target");
  await expect(page.getByTestId("dish-SALAD")).toContainText("40.0 %");
  await expect(page.getByTestId("dish-SALAD")).toContainText(/EGP\s?33\.34/);

  // What if tomatoes went to 30 / kg?
  await page.goto(`/o/${slug}/recipes/simulator`);
  await page.getByLabel("Ingredient").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByLabel(/^New cost per base unit/).fill("30");
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.getByTestId("sim-SALAD")).toContainText(/EGP\s?15\.00/);
  await expect(page.getByTestId("sim-SALAD")).toContainText("40.0 % → 60.0 %");

  // Replace tomato with cherry tomato and activate at once: 0.5 × 40 = 20.
  await page.goto(`/o/${slug}/recipes/replace`);
  await page.getByLabel("Product to replace").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByRole("button", { name: "Find recipes" }).click();
  await page.getByLabel("Replace with").selectOption({ label: "CHERRY — Cherry tomato (kg)" });
  await page.getByLabel(/Activate the new versions now/).check();
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByText("1 recipe changed: SALAD")).toBeVisible();
  await page.goto(`/o/${slug}/recipes/food-cost`);
  await expect(page.getByTestId("dish-SALAD")).toContainText(/EGP\s?20\.00/);
  await expect(page.getByTestId("dish-SALAD")).toContainText("80.0 %");
  await context.close();
});
