import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("a posted expense shows on the consolidated P&L; a customer marked as a group company (ADR-112)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("consolidated"),
    organization: "Group Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();

  await page.goto(`/o/${slug}/finance/expenses/setup`);
  const category = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add category" }) });
  await category.getByLabel("Code").fill("POWER");
  await category.getByLabel("Name", { exact: true }).fill("Electricity");
  await category.getByLabel(/^P&L group/).selectOption("UTILITIES");
  await category.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("cell", { name: "Electricity" })).toBeVisible();

  await page.goto(`/o/${slug}/finance/expenses/new`);
  await page.getByLabel("Category").selectOption({ index: 1 });
  await page.getByLabel("Description").fill("Electricity");
  await page.getByLabel("Net", { exact: true }).fill("1200");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: /^EXP-/ })).toBeVisible();

  await page.goto(`/o/${slug}/finance/consolidated`);
  await expect(page.getByRole("heading", { name: "Consolidated P&L" })).toBeVisible();
  await expect(
    page.getByTestId("group-row-UTILITIES").getByText("EGP 1,200.00").last(),
  ).toBeVisible();
  await expect(
    page.getByTestId("group-row-OPERATING_RESULT").getByText("-EGP 1,200.00").last(),
  ).toBeVisible();

  // A customer can be marked as one of the group's companies.
  await page.goto(`/o/${slug}/b2b/customers`);
  await page.getByLabel("Code").fill("SISTER");
  await page.getByLabel("Name", { exact: true }).fill("Sister Co");
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByRole("link", { name: "SISTER" }).click();
  const group = page.getByLabel(/^This customer is our company/);
  await group.selectOption({ index: 1 });
  const form = page.locator("form").filter({ has: group });
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(group).not.toHaveValue("");
  await context.close();
});
