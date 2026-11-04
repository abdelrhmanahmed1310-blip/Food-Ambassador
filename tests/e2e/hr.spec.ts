import { expect, test } from "@playwright/test";
import { newClient, orgDate, signUp, uniqueEmail } from "./helpers";

test("HR: department, employees with a reporting line, documents, overview and org chart (ADR-079)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("hr"),
    organization: "HR Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("RUH-01");
  await page.getByLabel("Name", { exact: true }).fill("Olaya");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Olaya" })).toBeVisible();

  // The HR tab: overview with real (empty) figures and the capability map.
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.locator("summary", { hasText: /^HR$/ }).click();
  await nav.getByRole("link", { name: "HR overview" }).click();
  await expect(page.getByRole("heading", { name: "Human resources" })).toBeVisible();
  await expect(page.getByTestId("hr-kpis")).toContainText("Active employees");
  const capabilities = page.getByTestId("hr-capabilities");
  await expect(capabilities.locator("li")).toHaveCount(11);
  await expect(capabilities).toContainText("Payroll");

  // A department.
  await page.goto(`/o/${slug}/hr/departments`);
  await page.getByLabel("Code", { exact: true }).fill("kitchen");
  await page.getByLabel("Department name").fill("Kitchen");
  await page.getByRole("button", { name: "Add department" }).click();
  await expect(page.getByTestId("department-row").filter({ hasText: "KITCHEN" })).toBeVisible();

  // Two employees: a head chef, and a cook reporting to her.
  const addEmployee = async (first: string, last: string, title: string, manager?: string) => {
    await page.goto(`/o/${slug}/hr/employees/new`);
    await page.getByLabel("First name").fill(first);
    await page.getByLabel("Last name").fill(last);
    await page.getByLabel("Job title").fill(title);
    await page.getByLabel(/^Department/).selectOption({ label: "KITCHEN — Kitchen" });
    if (manager) await page.getByLabel(/^Manager/).selectOption({ label: manager });
    await page.getByLabel("Hire date").fill("2026-01-10");
    await page.getByLabel(/^National ID/).fill("2123456789");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: `${first} ${last}` })).toBeVisible();
  };
  await addEmployee("Huda", "Saleh", "Head chef");
  await addEmployee("Omar", "Nasser", "Line cook", "Huda Saleh (EMP-00001)");
  await expect(page.getByText("2123456789")).toBeVisible();

  // A health certificate that expires today is flagged on the profile and the overview.
  const today = orgDate();
  await page.getByLabel("Document", { exact: true }).selectOption("HEALTH_CERTIFICATE");
  await page.getByLabel(/^Expires on/).fill(today);
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByTestId("employee-document")).toContainText("Expires soon");
  await page.goto(`/o/${slug}/hr`);
  await expect(page.getByTestId("hr-kpis")).toContainText("2");
  await expect(page.getByTestId("expiring-document")).toContainText("Omar Nasser");

  // The org chart follows the reporting line.
  await page.goto(`/o/${slug}/hr/org-chart`);
  const nodes = page.getByTestId("org-node");
  await expect(nodes).toHaveCount(2);
  await expect(nodes.first()).toContainText("Huda Saleh");

  // A manager with reports cannot leave until they are reassigned.
  await page.goto(`/o/${slug}/hr/employees`);
  await page.getByRole("link", { name: "Huda Saleh" }).click();
  await page.getByLabel("New status").selectOption("TERMINATED");
  await page.getByLabel("Last working day").fill(today);
  await page.getByLabel("Reason for leaving").fill("Resigned");
  await page.getByRole("button", { name: "Change status" }).click();
  await expect(
    page.getByText("Give this person's reports another manager first.").first(),
  ).toBeVisible();
  await context.close();
});
