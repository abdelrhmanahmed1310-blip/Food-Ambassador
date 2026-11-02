import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("leave: common types, entitlement, request, approval and balance (ADR-081)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner Amal",
    email: uniqueEmail("leave"),
    organization: "Leave Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();

  // Common leave types, no entitlements invented.
  await page.goto(`/o/${slug}/hr/leave/types`);
  await expect(
    page.getByText("No leave types yet: add the common ones or your own."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add common leave types" }).click();
  await expect(page.getByTestId("leave-type")).toHaveCount(10);
  await expect(page.getByTestId("leave-type").filter({ hasText: "HAJJ" })).toContainText(
    "Hajj leave",
  );

  // An employee with 21 days of annual leave; HR requests 3 days for him.
  const nextYear = new Date().getUTCFullYear() + 1;
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
  const leave = page.getByTestId("employee-leave");
  await leave.getByLabel("Leave type").first().selectOption({ label: "Annual leave" });
  await leave.getByLabel("Year").fill(String(nextYear));
  await leave.getByLabel("Days", { exact: true }).fill("21");
  await leave.getByRole("button", { name: "Set entitlement" }).click();
  await expect(page.getByText("Entitlement saved.").first()).toBeVisible();
  const request = leave
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Request leave for this employee" }) });
  await request.getByLabel("Leave type").selectOption({ label: "Annual leave" });
  await request.getByLabel("From").fill(`${nextYear}-03-01`);
  await request.getByLabel("To").fill(`${nextYear}-03-03`);
  await request.getByRole("button", { name: "Request leave for this employee" }).click();
  await expect(page.getByText("Leave requested.").first()).toBeVisible();

  // HR approves it from the leave list.
  await page.goto(`/o/${slug}/hr/leave`);
  const row = page.getByTestId("leave-row").filter({ hasText: "Omar Test" });
  await expect(row).toContainText("Waiting");
  await row.getByRole("button", { name: "Approve" }).click();
  // Wait for the approval to save: the request leaves the waiting list.
  await expect(row).toHaveCount(0);
  await page.goto(`/o/${slug}/hr/leave?status=APPROVED`);
  await expect(page.getByTestId("leave-row").filter({ hasText: "Omar Test" })).toContainText(
    "Approved",
  );

  // The owner, linked to an employee record, asks for their own leave and cannot approve it.
  await addEmployee("Amal", true);
  await page.goto(`/o/${slug}`);
  await page.getByRole("link", { name: "My leave" }).click();
  await page.getByLabel("Leave type").selectOption({ label: "Unpaid leave" });
  await page.getByLabel("From").fill(`${nextYear}-06-01`);
  await page.getByLabel("To").fill(`${nextYear}-06-02`);
  await page.getByRole("button", { name: "Request leave" }).click();
  await expect(page.getByText("Leave requested.").first()).toBeVisible();
  await page.goto(`/o/${slug}/hr/leave`);
  const own = page.getByTestId("leave-row").filter({ hasText: "Amal Test" });
  await expect(own).toContainText("Waiting");
  await expect(own.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await context.close();
});
