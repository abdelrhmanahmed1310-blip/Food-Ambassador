import { expect, test, type Page } from "@playwright/test";
import { newClient, PASSWORD, signUp, uniqueEmail } from "./helpers";

const ALLERGENS = [
  "Cereals containing gluten",
  "Crustaceans",
  "Eggs",
  "Fish",
  "Peanuts",
  "Soybeans",
  "Milk",
  "Tree nuts",
  "Celery",
  "Mustard",
  "Sulphur dioxide and sulphites",
  "Lupin",
  "Molluscs",
];

async function confirmClick(page: Page, name: string) {
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name }).click();
}

test("nutrition and allergens: values, statements, second-person verification, label approval, matrix", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await newClient(browser);
  const slug = await signUp(owner.page, {
    name: "Head Chef",
    email: uniqueEmail("chef"),
    organization: "Levant Kitchen",
  });
  // A quality manager joins to verify and approve.
  const qaEmail = uniqueEmail("qa");
  await owner.page.goto(`/o/${slug}/settings/members`);
  await owner.page.getByLabel("Email").fill(qaEmail);
  await owner.page.getByLabel("Role").selectOption({ label: "Food Safety / Quality" });
  await owner.page.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.page.getByLabel("Invitation link").inputValue();
  const qa = await newClient(browser);
  await qa.page.goto(new URL(link).pathname);
  await qa.page.getByRole("link", { name: "Create an account" }).click();
  await qa.page.getByLabel("Full name").fill("Quality Lead");
  await qa.page.getByLabel("Password").fill(PASSWORD);
  await qa.page.getByRole("button", { name: "Create account" }).click();
  await expect(qa.page).toHaveURL(new RegExp(`/o/${slug}$`));

  const page = owner.page;
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("TAHINI");
  await page.getByLabel("Name (English)").fill("Tahini");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Tahini" })).toBeVisible();
  await page.getByRole("link", { name: "Nutrition and allergens" }).click();
  await expect(page.getByText("No nutrition values recorded.")).toBeVisible();
  const productUrl = page.url();
  await expect(page.getByTestId("allergen-SESAME")).toContainText("Unknown");

  // Values for the test only (made up).
  const values = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save values" }) });
  await values.getByLabel("Source").selectOption("MANUAL");
  for (const [label, v] of [
    ["Energy (kcal)", "600"],
    ["Fat (g)", "50"],
    ["of which saturates (g)", "60"],
    ["Carbohydrate (g)", "20"],
    ["of which sugars (g)", "1"],
    ["Protein (g)", "17"],
    ["Salt (g)", "0.1"],
  ] as const)
    await values.getByLabel(new RegExp(`^${label.replace(/[()]/g, "\\$&")}`)).fill(v);
  await values.getByRole("button", { name: "Save values" }).click();
  await expect(values.getByText("Cannot be more than the fat.")).toBeVisible();
  await values.getByLabel(/^of which saturates/).fill("7");
  await values.getByRole("button", { name: "Save values" }).click();
  await expect(page.getByTestId("nutrient-fat")).toContainText("50");
  await expect(page.getByText("Not verified")).toBeVisible();

  const allergens = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save statements" }) });
  await allergens.getByLabel("Source").selectOption("SUPPLIER_SPEC");
  const allergen = (name: string) => allergens.getByLabel(new RegExp(`^${name}\\(`));
  await allergen("Sesame").selectOption("CONTAINS");
  for (const a of ALLERGENS) await allergen(a).selectOption("FREE_FROM");
  await allergens.getByRole("button", { name: "Save statements" }).click();
  await expect(allergens.getByText(/needs the specification or report/)).toBeVisible();
  await allergens.getByLabel(/^Reference/).fill("Spec T-1");
  await allergens.getByRole("button", { name: "Save statements" }).click();
  await expect(page.getByTestId("allergen-SESAME")).toContainText("Contains");
  await expect(page.getByTestId("allergen-FISH")).toContainText("Free from");
  // The author cannot verify their own statements.
  await expect(page.getByRole("button", { name: "Verify these values" })).toHaveCount(0);

  await page.goto(`/o/${slug}/recipes/new`);
  await page.getByLabel("Code").fill("DIP");
  await page.getByLabel("Type").selectOption("DISH");
  await page.getByLabel("Name (English)").fill("Tahini dip");
  await page.getByLabel("Yield quantity").fill("1");
  await page.getByLabel("Yield unit").selectOption({ label: "each — Each" });
  await page.getByLabel("Portions").fill("1");
  await page.getByRole("button", { name: "Create" }).click();
  const ingredient = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add ingredient" }) });
  await ingredient.getByLabel("Ingredient").selectOption({ label: "TAHINI — Tahini (kg)" });
  await ingredient.getByLabel("Net quantity").fill("0.2");
  await ingredient.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await ingredient.getByRole("button", { name: "Add ingredient" }).click();
  await expect(page.getByRole("cell", { name: /TAHINI/ }).first()).toBeVisible();
  await confirmClick(page, "Activate version");
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await page.goto(page.url().replace(/\/versions\/.*$/, "/nutrition"));
  const recipeUrl = page.url();
  await expect(page.getByTestId("recipe-nutrient-energyKcal")).toContainText("1,200");
  await expect(page.getByTestId("recipe-allergen-FISH")).toContainText("Unknown");
  await expect(page.getByTestId("label-blockers")).toContainText("verified");
  await expect(page.getByRole("button", { name: "Generate label" })).toHaveCount(0);

  // Quality sees what waits for them on the overview, then verifies.
  await qa.page.goto(`/o/${slug}`);
  await expect(qa.page.getByTestId("attention-STATEMENTS_TO_VERIFY")).toContainText(
    "1 product with nutrition or allergen data to verify",
  );
  await qa.page.goto(productUrl);
  await confirmClick(qa.page, "Verify these values");
  await expect(qa.page.getByText(/Verified by Quality Lead/).first()).toBeVisible();
  await confirmClick(qa.page, "Verify statements by others");
  await expect(qa.page.getByTestId("allergen-FISH")).toContainText("Verified by Quality Lead");

  await page.goto(recipeUrl);
  await expect(page.getByTestId("recipe-allergen-FISH")).toContainText("Free from");
  await confirmClick(page, "Generate label");
  await expect(page.getByText("Draft — not for use")).toBeVisible();
  await expect(page.getByTestId("label-portion-energyKcal")).toHaveText(/1200 kcal/);
  await expect(page.getByTestId("label-allergens")).toContainText("Contains: Sesame");
  await expect(page.getByRole("button", { name: "Print" })).toHaveCount(0);
  const labelUrl = page.url();

  await qa.page.goto(`/o/${slug}/attention`);
  await qa.page.getByTestId("attention-LABELS_TO_REVIEW").getByRole("link").first().click();
  await expect(qa.page).toHaveURL(labelUrl);
  await qa.page.getByLabel("Decision").selectOption("APPROVE");
  await qa.page.getByRole("button", { name: "Submit review" }).click();
  await expect(qa.page.getByText("Approved", { exact: true })).toBeVisible();
  await page.goto(labelUrl);
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  await expect(page.getByText("Draft — not for use")).toHaveCount(0);

  await page.goto(`/o/${slug}/recipes/allergens`);
  await expect(page.getByTestId("matrix-DIP").locator('[data-status="CONTAINS"]')).toHaveCount(1);
  await expect(page.getByTestId("matrix-DIP").locator('[data-status="FREE_FROM"]')).toHaveCount(13);
  await owner.context.close();
  await qa.context.close();
});
