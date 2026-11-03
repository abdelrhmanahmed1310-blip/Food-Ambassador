import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, newClient, signUp, uniqueEmail } from "./helpers";

async function invite(owner: Page, browser: Browser, slug: string, name: string, role: string) {
  await owner.goto(`/o/${slug}/settings/members`);
  await owner.getByLabel("Email").fill(uniqueEmail(name.toLowerCase().replace(/\s+/g, "-")));
  await owner.getByLabel("Role").selectOption({ label: role });
  await owner.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.getByLabel("Invitation link").inputValue();
  const client = await newClient(browser);
  await client.page.goto(new URL(link).pathname);
  await client.page.getByRole("link", { name: "Create an account" }).click();
  await client.page.getByLabel("Full name").fill(name);
  await client.page.getByLabel("Password").fill(PASSWORD);
  await client.page.getByRole("button", { name: "Create account" }).click();
  await expect(client.page).toHaveURL(new RegExp(`/o/${slug}$`));
  return client;
}

test("write an SOP, have it approved by someone else, confirm reading it (ADR-097)", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = await newClient(browser);
  const page = owner.page;
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("docs-owner"),
    organization: "Document Foods",
  });

  await page.goto(`/o/${slug}/food-safety/documents/new`);
  await page.getByLabel("Code").fill("SOP-01");
  await page.getByLabel("Title").fill("Hand washing");
  await page.getByLabel("Type").selectOption({ label: "Standard operating procedure" });
  await page.getByLabel("Text").fill("1. Wet hands.\n2. Soap for 20 seconds.\n3. Rinse and dry.");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "SOP-01 — Hand washing" })).toBeVisible();
  await expect(page.getByText("Not approved yet").first()).toBeVisible();
  await expect(page.getByText("Someone other than the author approves the version.")).toBeVisible();
  const docUrl = new URL(page.url()).pathname;

  const qa = await invite(page, browser, slug, "Quality Lead", "Food Safety / Quality");
  await qa.page.goto(docUrl);
  await qa.page.getByRole("button", { name: "Approve version" }).click();
  await expect(qa.page.getByText("Version 1 in force").first()).toBeVisible();
  await expect(qa.page.getByTestId("fs-doc-content")).toContainText("Soap for 20 seconds");

  await page.goto(`/o/${slug}/food-safety/documents?unread=1`);
  await expect(page.getByRole("link", { name: "SOP-01" })).toBeVisible();
  await page.goto(docUrl);
  await page.getByRole("button", { name: "I have read this version" }).click();
  await expect(page.getByText("You confirmed reading this version")).toBeVisible();
  await expect(page.getByText("1 person confirmed reading it")).toBeVisible();

  await qa.context.close();
  await owner.context.close();
});
