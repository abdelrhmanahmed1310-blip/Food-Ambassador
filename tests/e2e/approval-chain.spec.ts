import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, newClient, signUp, uniqueEmail } from "./helpers";

async function invite(
  owner: Page,
  browser: Browser,
  slug: string,
  opts: { name: string; role: string; branch?: string },
) {
  const email = uniqueEmail(opts.name.toLowerCase().replace(/\s+/g, "-"));
  await owner.goto(`/o/${slug}/settings/members`);
  await owner.getByLabel("Email").fill(email);
  await owner.getByLabel("Role").selectOption({ label: opts.role });
  if (opts.branch) {
    await owner.getByLabel("Scope").selectOption({ label: "One branch" });
    await owner.getByLabel("Branch", { exact: true }).selectOption({ label: opts.branch });
  }
  await owner.getByRole("button", { name: "Invite member" }).click();
  const link = await owner.getByLabel("Invitation link").inputValue();
  const client = await newClient(browser);
  await client.page.goto(new URL(link).pathname);
  await client.page.getByRole("link", { name: "Create an account" }).click();
  await client.page.getByLabel("Full name").fill(opts.name);
  await client.page.getByLabel("Password").fill(PASSWORD);
  await client.page.getByRole("button", { name: "Create account" }).click();
  await expect(client.page).toHaveURL(new RegExp(`/o/${slug}$`));
  return client;
}

test("purchase approval: two branch approvers, then head office", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await newClient(browser);
  const page = owner.page;
  const slug = await signUp(page, {
    name: "Owner",
    email: uniqueEmail("chain-owner"),
    organization: "Chain Foods",
  });
  await page.goto(`/o/${slug}/branches/new`);
  await page.getByLabel("Code", { exact: true }).fill("CAI-01");
  await page.getByLabel("Name", { exact: true }).fill("Cairo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Cairo" })).toBeVisible();
  await page.goto(`/o/${slug}/warehouses/new`);
  await page.getByLabel("Code", { exact: true }).fill("MAIN");
  await page.getByLabel("Name", { exact: true }).fill("Main store");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Main store" })).toBeVisible();
  await page.goto(`/o/${slug}/catalog/products/new`);
  await page.getByLabel("SKU").fill("FLOUR");
  await page.getByLabel("Name (English)").fill("Flour");
  await page.getByLabel("Base unit").selectOption({ label: "kg — Kilogram" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Flour" })).toBeVisible();
  await page.goto(`/o/${slug}/suppliers/new`);
  await page.getByLabel("Code", { exact: true }).fill("nile-mills");
  await page.getByLabel("Name", { exact: true }).fill("Nile Mills");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Nile Mills" })).toBeVisible();

  // Every order needs approval; the default chain is 2 branch steps + head office.
  await page.goto(`/o/${slug}/settings/purchasing`);
  await expect(page.getByLabel("Branch approvals")).toHaveValue("2");
  await expect(page.getByLabel("Head office approval")).toHaveValue("true");
  await page.getByLabel("Approval limit").fill("0");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Changes saved.").first()).toBeVisible();

  const b1 = await invite(page, browser, slug, {
    name: "Branch One",
    role: "Branch Manager",
    branch: "CAI-01 — Cairo",
  });
  const b2 = await invite(page, browser, slug, {
    name: "Branch Two",
    role: "Branch Manager",
    branch: "CAI-01 — Cairo",
  });
  const ho = await invite(page, browser, slug, { name: "Head Office", role: "Finance" });

  await page.goto(`/o/${slug}/suppliers`);
  await page.getByRole("link", { name: "Nile Mills" }).click();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await page.getByLabel("Deliver to").selectOption({ label: "MAIN — Main store" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: /^PO-/ })).toBeVisible();
  const orderUrl = new URL(page.url()).pathname;
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add line" }) });
  await form.getByLabel("Product").selectOption({ label: "FLOUR — Flour (kg)" });
  await form.getByLabel("Quantity").fill("10");
  await form.getByLabel("Unit", { exact: true }).selectOption({ label: "kg — Kilogram" });
  await form.getByLabel("Unit price").fill("20");
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?200\.00/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Awaiting approval", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("approval-steps")).toContainText("Step 1 of 3");
  await expect(page.getByText("You created or submitted this order")).toBeVisible();

  // Head office cannot sign a branch step.
  await ho.page.goto(orderUrl);
  await expect(ho.page.getByText("The next step needs an approver of another level")).toBeVisible();
  await expect(ho.page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);

  const sign = async (p: Page, label: string) => {
    await p.goto(orderUrl);
    p.once("dialog", (d) => d.accept());
    await p.getByRole("button", { name: label }).click();
  };
  await sign(b1.page, "Approve this step");
  await expect(b1.page.getByText("You approved an earlier step")).toBeVisible();
  await sign(b2.page, "Approve this step");
  await expect(b2.page.getByText("You approved an earlier step")).toBeVisible();
  await expect(b2.page.getByText("Step 3 of 3")).toBeVisible();
  await sign(ho.page, "Approve");
  await expect(ho.page.getByText("Approved", { exact: true })).toBeVisible();
  const steps = ho.page.getByTestId("approval-steps");
  await expect(steps).toContainText("Branch One");
  await expect(steps).toContainText("Branch Two");
  await expect(steps).toContainText("Head Office");

  for (const c of [owner, b1, b2, ho]) await c.context.close();
});
