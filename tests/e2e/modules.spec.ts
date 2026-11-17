import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("Settings → Modules: switch a module and a function off and back on (ADR-137)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("modules"),
    organization: "Switch Foods",
  });
  const nav = page.getByRole("navigation").first();
  await page.goto(`/o/${slug}/settings/modules`);
  await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible();
  // Core functions cannot be switched off.
  await expect(
    page.getByRole("checkbox", { name: /Products, units and categories/ }),
  ).toBeDisabled();

  // A dependency is explained, and nothing is saved.
  await page.getByRole("checkbox", { name: "Menu", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(/Not saved: .*“Till, registers, shifts and orders” needs “Menu”\./),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Menu", exact: true })).toBeChecked();

  // The whole HR module and the POS simulator function off.
  await page.getByTestId("module-hr").getByRole("checkbox", { name: "Human resources" }).uncheck();
  await expect(page.getByText(/The module is off/)).toBeVisible();
  await page.getByRole("checkbox", { name: "POS simulator" }).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. The menu now shows only what is on.")).toBeVisible();

  // Gone from the menu, and the pages answer "not found".
  await page.goto(`/o/${slug}`);
  await expect(nav.getByRole("link", { name: "POS simulator" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Employees", exact: true })).toHaveCount(0);
  await page.goto(`/o/${slug}/pos/simulator`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto(`/o/${slug}/hr/employees`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  // Other functions of the same module keep working.
  await page.goto(`/o/${slug}/pos`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);

  // Back on: everything returns as it was.
  await page.goto(`/o/${slug}/settings/modules`);
  await page.getByTestId("module-hr").getByRole("checkbox", { name: "Human resources" }).check();
  await page.getByRole("checkbox", { name: "POS simulator" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. The menu now shows only what is on.")).toBeVisible();
  await page.goto(`/o/${slug}/pos/simulator`);
  await expect(page.getByRole("heading", { name: "POS simulator" })).toBeVisible();
  await context.close();
});
