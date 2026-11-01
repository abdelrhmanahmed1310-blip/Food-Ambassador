import { devices, expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

// The App Store / Google Play apps load the web app with this user agent (ADR-061).
const STORE_APP_UA = `${devices["Pixel 7"].userAgent} FoodAmbassadorApp/1`;

test("store app: the same pages in the app's web view, with print buttons saying where to print", async ({
  browser,
}) => {
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "App",
    email: uniqueEmail("store-app"),
    organization: "App Foods",
  });
  await page.goto(`/o/${slug}/recipes/allergens`);
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  await expect(page.getByTestId("print-unavailable")).toHaveCount(0);

  // The same session inside the store app.
  const app = await browser.newContext({
    storageState: await context.storageState(),
    userAgent: STORE_APP_UA,
    viewport: { width: 412, height: 915 },
  });
  const inApp = await app.newPage();
  await inApp.goto(`/o/${slug}/recipes/allergens`);
  await expect(inApp.getByTestId("print-unavailable")).toBeVisible();
  await expect(inApp.getByRole("button", { name: "Print" })).toHaveCount(0);
  await app.close();
  await context.close();
});
