import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("engagement: an anonymous survey held back below five answers, and recognition (ADR-127)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head of HR",
    email: uniqueEmail("engage"),
    organization: "Engaged Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();
  const hire = async (first: string, linkMe: boolean) => {
    await page.goto(`/o/${slug}/hr/employees/new`);
    await page.getByLabel("First name").fill(first);
    await page.getByLabel("Last name").fill("Test");
    await page.getByLabel("Job title").fill("Staff");
    await page.getByLabel("Hire date").fill("2026-01-10");
    if (linkMe) await page.getByLabel(/^Sign-in account/).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: `${first} Test` })).toBeVisible();
  };
  await hire("Huda", true); // the HR person is also staff
  await hire("Omar", false);

  // A survey with an eNPS question, opened to everyone.
  await page.goto(`/o/${slug}/hr/engagement`);
  await page.getByLabel("Title").fill("Pulse check");
  await page.getByRole("button", { name: "New survey" }).click();
  await expect(page.getByRole("heading", { name: "Pulse check" })).toBeVisible();
  const surveyUrl = page.url();
  await page.getByLabel("Type").selectOption({ label: "0–10 recommend (eNPS)" });
  await page.getByLabel("Question", { exact: true }).fill("Would you recommend working here?");
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(page.getByText(/1\. Would you recommend working here\?/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Open survey" }).click();
  await expect(page.getByTestId("survey-responses")).toContainText("No answers yet");

  // Answering, anonymously.
  await page.goto(`/o/${slug}/my/surveys`);
  await page.getByRole("link", { name: "Answer now" }).click();
  await page.getByRole("radio", { name: "9" }).check();
  await page.getByRole("button", { name: "Send my answers" }).click();
  await expect(page.getByText("Thank you — your answers were sent anonymously.")).toBeVisible();
  await expect(page.getByText("No surveys waiting for you.")).toBeVisible();

  // One answer: results are held back.
  await page.goto(surveyUrl);
  await expect(page.getByTestId("survey-responses")).toContainText("1 answer");
  await expect(
    page.getByText("Results show from 5 answers, so that nobody can be identified."),
  ).toBeVisible();

  // A thank-you on the wall, then hidden by HR with a reason.
  await page.goto(`/o/${slug}/recognition`);
  await page.getByLabel("Colleague").selectOption({ label: "Omar Test (RUH-01)" });
  await page.getByLabel("For").selectOption({ label: "Food safety" });
  await page.getByLabel("Message").fill("Spotted the fridge alarm at closing");
  await page.getByRole("button", { name: "Send thanks" }).click();
  const wall = page.getByTestId("recognition-wall");
  await expect(wall).toContainText("Spotted the fridge alarm at closing");
  await wall.getByLabel("Why hide").fill("Test post");
  await wall.getByRole("button", { name: "Hide" }).click();
  await expect(wall).toContainText("Hidden: Test post");
  await context.close();
});
