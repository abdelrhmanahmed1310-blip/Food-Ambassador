import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("rosters: settings, a shift template, a published shift, and an onboarding checklist (ADR-128)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head of HR",
    email: uniqueEmail("roster"),
    organization: "Rostered Foods",
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
    await page.getByLabel("Job title").fill("Cook");
    await page.getByLabel("Hire date").fill("2026-01-10");
    if (linkMe) await page.getByLabel(/^Sign-in account/).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: `${first} Test` })).toBeVisible();
    return page.url();
  };
  const hudaUrl = await hire("Huda", true);
  await hire("Omar", false);

  // The organization's own policy: nothing is preset.
  await page.goto(`/o/${slug}/hr/rosters/settings`);
  await page.getByLabel("Grace minutes").fill("5");
  await page.getByLabel("Overtime minimum (minutes)").fill("15");
  await page.getByLabel("Standard daily hours").fill("8");
  await page.getByLabel("Overtime multiplier").fill("1.5");
  await page.getByLabel("Overtime is paid on").selectOption({ label: "Basic pay" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const templateForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add shift template" }) });
  await templateForm.getByLabel("Code").fill("AM");
  await templateForm.getByLabel("Name").fill("Morning");
  await templateForm.getByLabel("Start").fill("09:00");
  await templateForm.getByLabel("End").fill("17:00");
  await templateForm.getByLabel("Break (minutes)").fill("60");
  await templateForm.getByRole("button", { name: "Add shift template" }).click();
  await expect(page.getByRole("cell", { name: "Morning" })).toBeVisible();

  // A draft shift, then published to staff.
  await page.goto(`/o/${slug}/hr/rosters`);
  const shiftForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add shift" }) });
  await shiftForm.getByLabel("Employee").selectOption({ label: "Omar Test" });
  await shiftForm.getByLabel("Day").selectOption({ index: 6 });
  await shiftForm
    .getByLabel("Shift", { exact: true })
    .selectOption({ label: "Morning (09:00–17:00)" });
  await shiftForm.getByRole("button", { name: "Add shift" }).click();
  const shift = page.getByTestId("roster-shift");
  await expect(shift).toContainText("09:00–17:00");
  await expect(shift).toContainText("Draft");
  await expect(page.getByTestId("roster-totals")).toContainText("7:00");
  // The same person twice at once is refused.
  await shiftForm.getByLabel("Employee").selectOption({ label: "Omar Test" });
  await shiftForm.getByLabel("Day").selectOption({ index: 6 });
  await shiftForm
    .getByLabel("Shift", { exact: true })
    .selectOption({ label: "Morning (09:00–17:00)" });
  await shiftForm.getByRole("button", { name: "Add shift" }).click();
  await expect(page.getByText("This person already has a shift at this time.")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish 1 draft shift" }).click();
  await expect(shift).not.toContainText("Draft");
  await shift.getByRole("link").click();
  await expect(page.getByRole("heading", { name: /Omar Test · 09:00–17:00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel shift" })).toBeVisible();

  // An onboarding checklist: HR's task and the new hire's own.
  await page.goto(`/o/${slug}/hr/onboarding/templates`);
  await page.getByLabel("Code").fill("NEW");
  await page.getByLabel("Name").fill("New starter");
  await page.getByRole("button", { name: "Create checklist" }).click();
  await expect(page.getByText("NEW — New starter")).toBeVisible();
  const addTask = async (title: string, days: string, who: string) => {
    await page.getByLabel("Task", { exact: true }).fill(title);
    await page.getByLabel("Due after (days)").fill(days);
    await page.getByLabel("For", { exact: true }).selectOption({ label: who });
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText(title)).toBeVisible();
  };
  await addTask("Contract signed", "0", "HR");
  await addTask("Read the handbook", "3", "New employee");
  await page.goto(hudaUrl);
  await page.getByLabel("Checklist").selectOption({ label: "New starter" });
  await page.getByRole("button", { name: "Start checklist" }).click();
  await expect(page.getByRole("heading", { name: "Huda Test · New starter" })).toBeVisible();
  await page.getByRole("button", { name: "Done: Read the handbook" }).click();
  await expect(page.getByRole("button", { name: "Done: Read the handbook" })).toBeHidden();
  await page.getByRole("button", { name: "Done: Contract signed" }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();

  // Huda's own roster: nothing published for her.
  await page.goto(`/o/${slug}/my/roster`);
  await expect(page.getByText("No shifts published for you yet.")).toBeVisible();
  await context.close();
});
