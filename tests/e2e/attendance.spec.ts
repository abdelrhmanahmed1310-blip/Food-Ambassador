import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("attendance: branch tablet with number and PIN, phone clock-in, board and history (ADR-080)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner Amal",
    email: uniqueEmail("att"),
    organization: "Clock Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();

  // An employee with a PIN, and the owner's own employee record linked to their account.
  const addEmployee = async (first: string, linkSelf: boolean) => {
    await page.goto(`/o/${slug}/hr/employees/new`);
    await page.getByLabel("First name").fill(first);
    await page.getByLabel("Last name").fill("Test");
    await page.getByLabel("Job title").fill("Staff");
    await page.getByLabel("Hire date").fill("2026-01-10");
    if (linkSelf) await page.getByLabel(/^Sign-in account/).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: `${first} Test` })).toBeVisible();
  };
  await addEmployee("Omar", false);
  await page.getByLabel("New PIN").fill("4821");
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByText("PIN set.").first()).toBeVisible();

  // A tablet for the branch; its link works without signing in.
  await page.goto(`/o/${slug}/hr/attendance/setup`);
  await page.getByLabel("Tablet name").fill("Kitchen door");
  await page.getByRole("button", { name: "Add tablet" }).click();
  const link = await page.getByTestId("terminal").getByLabel("Tablet link").inputValue();
  const tablet = await browser.newContext();
  const t = await tablet.newPage();
  await t.goto(new URL(link).pathname);
  await expect(t.getByRole("heading", { name: "Clock in / out" })).toBeVisible();
  const tap = async (pin: string) => {
    await t.getByLabel("Employee number").fill("EMP-00001");
    await t.getByLabel("PIN").fill(pin);
    await t.getByRole("button", { name: "Clock in / out" }).click();
  };
  await tap("1111");
  await expect(t.getByText("Check your employee number and PIN.")).toBeVisible();
  await tap("4821");
  await expect(t.getByTestId("clock-result")).toContainText("Welcome, Omar");
  await tap("4821");
  await expect(t.getByTestId("clock-result")).toContainText("Goodbye, Omar");
  await tap("4821");
  await expect(t.getByTestId("clock-result")).toContainText("Welcome, Omar");
  await tablet.close();

  // The board shows Omar in now; his page lists the punches.
  await page.goto(`/o/${slug}/hr/attendance`);
  await expect(page.getByTestId("in-now")).toContainText("1 person is clocked in now.");
  const row = page.getByTestId("attendance-row").filter({ hasText: "Omar Test" });
  await expect(row).toContainText("In");
  await row.getByRole("link", { name: "Omar Test" }).click();
  await expect(page.getByTestId("punch-row")).toHaveCount(3);
  await expect(page.getByTestId("punch-row").first()).toContainText("Tablet · Kitchen door");

  // Phone clock-in for a signed-in employee (no branch location set: from anywhere).
  await addEmployee("Amal", true);
  await page.goto(`/o/${slug}`);
  await page.getByRole("link", { name: "My attendance" }).click();
  await expect(page.getByTestId("my-state")).toHaveText("You are clocked out.");
  await page.getByRole("button", { name: "Clock in" }).click();
  await expect(page.getByText("Clocked in.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("my-state")).toHaveText("You are clocked in.");
  await context.close();
});
