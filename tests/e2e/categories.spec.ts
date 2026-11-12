import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("product categories: a subcategory by hand, more in bulk from a CSV, shown as a tree (ADR-134)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Catalog Lead",
    email: uniqueEmail("categories"),
    organization: "Tree Foods",
  });
  await page.goto(`/o/${slug}/catalog/categories`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create" }) });
  await form.getByLabel("Code", { exact: true }).fill("BEV");
  await form.getByLabel("Name", { exact: true }).fill("Beverages");
  await form.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("category-BEV")).toBeVisible();
  await form.getByLabel("Code", { exact: true }).fill("HOT");
  await form.getByLabel("Name", { exact: true }).fill("Hot drinks");
  await form.getByLabel("Parent category").selectOption({ label: "BEV — Beverages" });
  await form.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("category-HOT")).toContainText("↳");

  // Bulk upload: a subcategory of an existing one, and a new branch of the tree.
  const dir = mkdtempSync(join(tmpdir(), "categories-"));
  const file = join(dir, "categories.csv");
  writeFileSync(
    file,
    "code,name,name_ar,parent_code\nCOF,Coffee,قهوة,HOT\nDAIRY,Dairy,ألبان,\nDAI-MILK,Milk,حليب,DAIRY\n",
  );
  const upload = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Validate and import" }) });
  await upload.locator('input[type="file"]').setInputFiles(file);
  await upload.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("3 categories added, 0 updated.")).toBeVisible();
  await page.reload();
  const order = await page
    .locator('[data-testid^="category-"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")));
  expect(order).toEqual([
    "category-BEV",
    "category-HOT",
    "category-COF",
    "category-DAIRY",
    "category-DAI-MILK",
  ]);

  // The same upload updates what exists: Coffee renamed and moved to the top.
  const update = join(dir, "update.csv");
  writeFileSync(update, "code,name,name_ar,parent_code\nCOF,Coffee beans,بن,\n");
  await upload.locator('input[type="file"]').setInputFiles(update);
  await upload.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("0 categories added, 1 updated.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("category-COF")).toContainText("Coffee beans");
  await expect(page.getByTestId("category-COF")).not.toContainText("↳");
  writeFileSync(update, "code,name,name_ar,parent_code\nCOF,Coffee,قهوة,HOT\n");
  await upload.locator('input[type="file"]').setInputFiles(update);
  await upload.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("0 categories added, 1 updated.")).toBeVisible();

  // A fourth level is refused, with the row and the reason.
  const deep = join(dir, "deep.csv");
  writeFileSync(deep, "code,name,parent_code\nESP,Espresso,COF\n");
  await upload.locator('input[type="file"]').setInputFiles(deep);
  await upload.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("Categories are at most three levels deep.")).toBeVisible();

  // The product picker shows the full path.
  await page.goto(`/o/${slug}/catalog/products/new`);
  await expect(
    page
      .getByLabel("Category")
      .locator("option", { hasText: "COF — Beverages › Hot drinks › Coffee" }),
  ).toHaveCount(1);
  await context.close();
});
