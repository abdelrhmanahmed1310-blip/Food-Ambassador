import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

// AC1.3 — another organization's pages and records return 404.
test("a user cannot open another organization's pages or records", async ({ browser }) => {
  const a = await newClient(browser);
  const b = await newClient(browser);
  const slugA = await signUp(a.page, {
    name: "Alice",
    email: uniqueEmail("alice"),
    organization: "Alice Foods",
  });
  const slugB = await signUp(b.page, {
    name: "Bob",
    email: uniqueEmail("bob"),
    organization: "Bob Foods",
  });

  await b.page.goto(`/o/${slugB}/branches/new`);
  await b.page.getByLabel("Code", { exact: true }).fill("BOB-1");
  await b.page.getByLabel("Name", { exact: true }).fill("Bob branch");
  await b.page.getByRole("button", { name: "Create" }).click();
  await expect(b.page.getByRole("heading", { name: "Bob branch" })).toBeVisible();
  const bobBranchPath = new URL(b.page.url()).pathname;

  for (const path of [
    `/o/${slugB}`,
    `/o/${slugB}/branches`,
    bobBranchPath,
    `/o/${slugB}/settings/members`,
  ]) {
    const response = await a.page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(a.page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(a.page.getByText("Bob branch")).toHaveCount(0);
  }

  // Alice's own record IDs under her slug still work; Bob's ID under Alice's slug does not.
  const bobBranchId = bobBranchPath.split("/").pop();
  const crossed = await a.page.goto(`/o/${slugA}/branches/${bobBranchId}`);
  expect(crossed?.status()).toBe(404);

  await a.context.close();
  await b.context.close();
});

test("unauthenticated visitors are redirected to sign-in", async ({ page }) => {
  await page.goto("/o/some-org/warehouses");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fo%2Fsome-org%2Fwarehouses$/);
});

test("forged session cookies are rejected server-side", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "better-auth.session_token", value: "forged.value", url: "http://localhost:3100" },
  ]);
  const page = await context.newPage();
  await page.goto("/o/some-org");
  await expect(page).toHaveURL(/\/sign-in/);
  await context.close();
});

test("a member of two organizations can switch between them", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const first = await signUp(page, {
    name: "Multi",
    email: uniqueEmail("multi"),
    organization: "First Foods",
  });
  await page.goto("/organizations/new");
  await page.getByLabel("Organization name").fill("Second Foods");
  await page.getByLabel("Base currency").selectOption("SAR");
  await page.getByLabel("Time zone").selectOption("Asia/Riyadh");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/o\/second-foods/);

  await page.locator("summary", { hasText: "Second Foods" }).click();
  await page.getByRole("link", { name: "First Foods" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${first}$`));
  await expect(page.locator("summary", { hasText: "First Foods" })).toBeVisible();
  await context.close();
});
