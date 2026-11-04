import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("menu engineering classifies nothing until something with a cost is sold (ADR-107)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("menu-engineering"),
    organization: "Matrix Foods",
  });
  await page.goto(`/o/${slug}/reports/menu-engineering`);
  await expect(page.getByRole("heading", { name: "Menu engineering" })).toBeVisible();
  await expect(page.getByText("Nothing to classify yet", { exact: false })).toBeVisible();
  await expect(page.getByText("No menu items sold in this period.")).toBeVisible();
  const classes = page.getByTestId("menu-classes");
  for (const c of ["Stars", "Plowhorses", "Puzzles", "Dogs"])
    await expect(classes.getByText(c, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Menu category")).toBeVisible();
  const csv = await page.request.get(
    (await page.getByRole("link", { name: "Download CSV" }).getAttribute("href"))!,
  );
  expect((await csv.text()).split("\n")[0]).toContain("class");
  await context.close();
});
