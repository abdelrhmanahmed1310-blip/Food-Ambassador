import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("companies and brands: a legal entity, a brand, and a branch under them (ADR-082)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("ent"),
    organization: "Group Foods",
  });

  // Every organization starts with its default company.
  await page.goto(`/o/${slug}/settings/companies`);
  await expect(page.getByTestId("company-MAIN")).toContainText("Default");
  const add = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add company" }) });
  await add.getByLabel("Code", { exact: true }).fill("ksa-llc");
  await add.getByLabel("Trading name").fill("Group KSA");
  await add.getByLabel("Legal name").fill("Group Trading Company LLC");
  await add.getByLabel(/^Country/).fill("SA");
  await add.getByLabel(/^VAT number/).fill("399999999900003");
  await add.getByRole("button", { name: "Add company" }).click();
  await expect(page.getByTestId("company-KSA-LLC")).toContainText("0 branches");

  await page.goto(`/o/${slug}/settings/brands`);
  await page.getByLabel("Code", { exact: true }).fill("brg");
  await page.getByLabel("Brand name").fill("Olaya Burgers");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.getByTestId("brand-row")).toContainText("Olaya Burgers");

  // A branch of the new company, with the brand.
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("JED-01");
  await page.getByLabel("Name", { exact: true }).fill("Jeddah");
  await page.getByLabel("Company").selectOption({ label: "KSA-LLC — Group KSA" });
  await page.getByLabel(/^Brand/).selectOption({ label: "BRG — Olaya Burgers" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Jeddah" })).toBeVisible();
  await expect(page.getByText(/Company: Group KSA · Brand: Olaya Burgers/)).toBeVisible();
  await page.goto(`/o/${slug}/branches`);
  await expect(page.getByRole("row").filter({ hasText: "Jeddah" })).toContainText("Group KSA");

  // The default company cannot be archived; it has no archive button.
  await page.goto(`/o/${slug}/settings/companies`);
  await expect(
    page.getByTestId("company-MAIN").getByRole("button", { name: "Archive" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("company-KSA-LLC")).toContainText("1 branch");
  await context.close();
});
