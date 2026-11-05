import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("training: course required of a job, a session, a certificate, the matrix (ADR-125)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Trainer",
    email: uniqueEmail("learning"),
    organization: "Learning Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  await page.goto(`/o/${slug}/hr/employees/new`);
  await page.getByLabel("First name").fill("Huda");
  await page.getByLabel("Last name").fill("Saleh");
  await page.getByLabel("Job title").fill("Line cook");
  await page.getByLabel("Hire date").fill("2026-01-10");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Huda Saleh" })).toBeVisible();

  // A food hygiene course, valid 12 months, required of line cooks within 30 days.
  await page.goto(`/o/${slug}/hr/learning/courses`);
  await page.getByLabel("Code").fill("FH");
  await page.getByLabel("Name", { exact: true }).fill("Food hygiene");
  await page.getByLabel("Certificate valid (months)").fill("12");
  await page.getByRole("button", { name: "Add course" }).click();
  const course = page.getByTestId("course-FH");
  await expect(course).toContainText("Valid 12 months");
  await course.locator("summary", { hasText: "Say who must hold it" }).click();
  await course.getByLabel("Required of").selectOption({ label: "Job title" });
  await course.getByLabel("Job title").fill("LINE COOK");
  await course.getByRole("button", { name: "Say who must hold it" }).click();
  await expect(course).toContainText("Job title: LINE COOK · due within 30 days of hire");

  // Hired in January: overdue.
  await page.goto(`/o/${slug}/hr/learning`);
  const row = page.getByTestId("training-EMP-00001");
  await expect(row).toContainText("Overdue");

  // A session: Huda attends and passes.
  await page.goto(`/o/${slug}/hr/learning/sessions`);
  await page.getByLabel("Trainer").fill("Nour");
  await page.getByRole("button", { name: "Schedule a session" }).click();
  await expect(page.getByRole("heading", { name: /^TRN-/ })).toBeVisible();
  await page.getByLabel(/EMP-00001/).check();
  await page.getByRole("button", { name: "Add participants" }).click();
  const p = page.getByTestId("participant-EMP-00001");
  await p.getByLabel("Attendance").selectOption({ label: "Attended" });
  await p.getByLabel("Result").selectOption({ label: "Passed" });
  await p.getByRole("button", { name: "Save" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Complete session" }).click();
  // The session closes: attendance is fixed and the button goes.
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(p).toContainText("Passed");
  await expect(page.getByRole("button", { name: "Complete session" })).toHaveCount(0);

  await page.goto(`/o/${slug}/hr/learning`);
  await expect(row).toContainText("Valid");
  await page.getByRole("link", { name: "Huda Saleh" }).click();
  await expect(page.getByTestId("employee-training")).toContainText("Valid");
  await context.close();
});
