import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("sales import uses stock through recipes and skips lines already imported", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Manager",
    email: uniqueEmail("sales"),
    organization: "Selling Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("KITCH");
  await page.getByLabel("Name", { exact: true }).fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Kitchen" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("TOMATO");
  await page.getByLabel("Name (English)").fill("Tomato");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Tomato" })).toBeVisible();
  await page.goto(`/o/${slug}/inventory/opening/new`);
  await page.getByLabel("Warehouse").selectOption({ label: "KITCH — Kitchen" });
  await page.getByLabel("Product").selectOption({ label: "TOMATO — Tomato (kg)" });
  await page.getByLabel("Quantity").fill("10");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await page.getByLabel("Unit cost").fill("20");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("heading", { name: /^OB-/ })).toBeVisible();

  // Salad: 1 portion uses 0.5 kg tomato.
  await page.goto(`/o/${slug}/recipes/new`);
  await page.getByLabel("Code").fill("SALAD");
  await page.getByLabel("Type").selectOption("DISH");
  await page.getByLabel("Name (English)").fill("Salad");
  await page.getByLabel("Yield quantity").fill("1");
  await page.getByLabel("Yield unit").selectOption({ label: "each — Each" });
  await page.getByLabel("Portions").fill("1");
  await page.getByRole("button", { name: "Create" }).click();
  const ing = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add ingredient" }) });
  await ing.getByLabel("Ingredient").selectOption({ label: "TOMATO — Tomato (kg)" });
  await ing.getByLabel("Net quantity").fill("0.5");
  await ing.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await ing.getByRole("button", { name: "Add ingredient" }).click();
  await expect(page.getByTestId("recipe-portion")).toHaveText(/EGP\s?10\.00/);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Activate version" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();

  const file = join(tmpdir(), `sales-${Date.now()}.csv`);
  writeFileSync(
    file,
    "date,external_id,item_code,quantity,net_amount\n2026-11-01,T-1,SALAD,4,200\n2026-11-01,T-2,NOPE,1,10\n",
  );
  await page.goto(`/o/${slug}/sales`);
  await page.getByLabel("Warehouse").selectOption({ label: "KITCH — Kitchen" });
  await page.getByLabel(/^CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("No recipe or product with code NOPE.")).toBeVisible();

  writeFileSync(
    file,
    "date,external_id,item_code,quantity,net_amount\n2026-11-01,T-1,SALAD,4,200\n",
  );
  await page.getByLabel(/^CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("1 line imported.")).toBeVisible();
  // Uploading the same file again posts nothing.
  await page.getByLabel(/^CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("Nothing new to import; 1 already imported.")).toBeVisible();

  await page.getByRole("link", { name: /^SAL-/ }).first().click();
  await expect(page.getByRole("heading", { name: /^SAL-/ })).toBeVisible();
  await expect(page.getByTestId("cost-of-sales")).toHaveText(/EGP\s?40\.00/);
  await page.goto(`/o/${slug}/inventory/stock`);
  await expect(page.getByRole("cell", { name: "8 kg" })).toBeVisible();
  await context.close();
});
