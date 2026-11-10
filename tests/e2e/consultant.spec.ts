import { expect, test } from "@playwright/test";
import { newClient, signUp, uniqueEmail } from "./helpers";

test("food consultant: in the menu in English and Arabic, off until the assistant key is connected (ADR-131)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await newClient(browser);
  const slug = await signUp(page, {
    name: "Head Chef",
    email: uniqueEmail("consultant"),
    organization: "Consulted Foods",
  });
  await page.goto(`/o/${slug}`);
  await page.getByRole("link", { name: "Food Consultant Chatbot" }).first().click();
  await expect(page.getByRole("heading", { name: "Food Consultant Chatbot" })).toBeVisible();
  // It shares the assistant's key and switch: off until they are set.
  await expect(page.getByText("The assistant is not switched on.")).toBeVisible();

  // Arabic interface: the same page in Arabic, right to left.
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.getByRole("heading", { name: "المستشار الغذائي الآلي" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await context.close();
});
