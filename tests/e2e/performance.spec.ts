import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("performance: cycle, goal, HR review without a manager, final rating (ADR-126)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head of HR",
    email: uniqueEmail("perf"),
    organization: "Rated Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  await page.goto(`/o/${slug}/hr/employees/new`);
  await page.getByLabel("First name").fill("Omar");
  await page.getByLabel("Last name").fill("Nasser");
  await page.getByLabel("Job title").fill("Line cook");
  await page.getByLabel("Hire date").fill("2026-01-10");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Omar Nasser" })).toBeVisible();
  const employeeUrl = page.url();

  await page.goto(`/o/${slug}/hr/performance`);
  await page.getByLabel("Name", { exact: true }).fill("2026 review");
  await page.getByLabel("Period from").fill("2026-01-01");
  await page.getByLabel("Period to").fill("2026-12-31");
  await page.getByLabel("Self-reviews due").fill("2026-12-10");
  await page.getByLabel("Manager reviews due").fill("2026-12-20");
  await page.getByRole("button", { name: "New review cycle" }).click();
  await expect(page.getByRole("heading", { name: "2026 review" })).toBeVisible();
  const cycleUrl = page.url();

  // A weighted goal in the cycle, set from the employee page.
  await page.goto(employeeUrl);
  const goals = page.getByTestId("employee-goals");
  await goals.locator("summary", { hasText: "Add goal" }).click();
  await goals.getByLabel("Goal", { exact: true }).fill("Cut waste by 10 %");
  await goals.getByLabel("Cycle").selectOption({ label: "2026 review" });
  await goals.getByLabel("Weight (%)").fill("100");
  await goals.getByRole("button", { name: "Add goal" }).click();
  await expect(goals.getByRole("cell", { name: /Cut waste by 10 %/ })).toBeVisible();

  await page.goto(cycleUrl);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Launch cycle" }).click();
  const row = page.getByTestId("review-EMP-00001");
  await expect(row).toContainText("HR");
  await row.getByRole("link", { name: "Omar Nasser" }).click();

  // No manager on record: HR rates the goal and the year.
  await page
    .getByLabel("Rating: Cut waste by 10 % (100%)")
    .selectOption({ label: "4 — Exceeds expectations" });
  await page.getByLabel("Overall rating").selectOption({ label: "4 — Exceeds expectations" });
  await page.getByLabel("Strengths").fill("Careful with stock");
  await page.getByLabel("To work on").fill("Pace on busy nights");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(page.getByText("Rated by manager", { exact: true })).toBeVisible();
  await page.getByLabel("Final rating").selectOption({ label: "5 — Outstanding" });
  await page.getByRole("button", { name: "Finalize" }).click();
  await expect(page.getByText("Say why the rating changes.")).toBeVisible();
  await page.getByLabel("Why the rating changed").fill("Calibrated across branches");
  await page.getByRole("button", { name: "Finalize" }).click();
  await expect(page.getByText("Final", { exact: true })).toBeVisible();
  await expect(page.getByTestId("review")).toContainText("5 — Outstanding");

  await page.goto(cycleUrl);
  await expect(page.getByTestId("rating-distribution")).toContainText("5 — Outstanding");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Close cycle" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  await context.close();
});
