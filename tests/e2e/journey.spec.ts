import { expect, test } from "@playwright/test";
import { PASSWORD, newClient, signUp, uniqueEmail } from "./helpers";

// AC1.10 — sign-up → create branch → create warehouse → switch language → sign out.
test("owner onboarding journey", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const email = uniqueEmail("journey");
  const slug = await signUp(page, {
    name: "Journey Owner",
    email,
    organization: "Journey Kitchen",
  });
  await expect(page.getByRole("heading", { name: "Welcome, Journey Owner" })).toBeVisible();

  // Create a branch.
  await page.getByRole("link", { name: "Branches" }).first().click();
  await page.getByRole("link", { name: "New branch" }).first().click();
  await page.getByLabel("Code", { exact: true }).fill("cai-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo Downtown");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo Downtown" })).toBeVisible();

  // Create a warehouse in it.
  await page.getByRole("link", { name: "View warehouses" }).click();
  await page.getByRole("link", { name: "New warehouse" }).first().click();
  await page.getByLabel("Code", { exact: true }).fill("CAI-MAIN");
  await page.getByLabel("Name", { exact: true }).fill("Main store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Main store" })).toBeVisible();

  // Add a storage location.
  const addLocation = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add location" }) });
  await addLocation.getByLabel("Code", { exact: true }).fill("CHILL-1");
  await addLocation.getByLabel("Name", { exact: true }).fill("Walk-in chiller");
  await addLocation.getByLabel("Temperature zone").selectOption("CHILLED");
  await addLocation.getByRole("button", { name: "Add location" }).click();
  await expect(page.locator("form [role=status]")).toHaveText("Location added.");
  await expect(page.getByRole("cell", { name: "Walk-in chiller" })).toBeVisible();

  // Overview counts come from real data.
  await page.goto(`/o/${slug}`);
  await expect(page.getByRole("link", { name: /Active branches\s*1/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Active warehouses\s*1/ })).toBeVisible();

  // Switch to Arabic: RTL layout and translated navigation; persisted across reloads.
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("link", { name: "الفروع" }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  // Audit log shows what happened.
  await page.goto(`/o/${slug}/settings/audit`);
  await expect(page.getByRole("cell", { name: "warehouse.created" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "branch.created" })).toBeVisible();

  // Sign out; tenant pages now require sign-in.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto(`/o/${slug}/branches`);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=%2Fo%2F${slug}%2Fbranches`));

  // Sign back in and return to the requested page.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/branches$`));
  await expect(page.getByRole("link", { name: "Cairo Downtown" })).toBeVisible();
  await context.close();
});

test("server-side validation errors are shown per field", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Validator",
    email: uniqueEmail("validate"),
    organization: "Validation Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("bad code!");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator("form [role=alert]")).toHaveText(
    "Please correct the highlighted fields.",
  );
  await expect(page.getByText("Use capital letters, digits, “-” and “_” (max 20).")).toBeVisible();
  await expect(page.getByText("This field is required.")).toBeVisible();
  // The entered value is kept.
  await expect(page.getByLabel("Code", { exact: true })).toHaveValue("bad code!");
  await context.close();
});

test("wrong password is rejected with a generic message", async ({ browser }) => {
  const { context, page } = await newClient(browser);
  const email = uniqueEmail("wrongpw");
  await signUp(page, { name: "Wrong PW", email, organization: "PW Foods" });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form [role=alert]")).toHaveText("Incorrect email or password.");
  await context.close();
});
