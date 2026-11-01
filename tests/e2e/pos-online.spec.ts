import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("online ordering: a guest orders on the web and at a kiosk, the branch accepts (ADR-070)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-online");
  await expect(page.getByRole("link", { name: "Open till" })).toBeVisible();

  // Cola is also sold for take-away; guest orders are checks, so the branch needs a floor.
  await page.goto(`/o/${slug}/menu`);
  await page.getByRole("link", { name: "COLA", exact: true }).click();
  await page.waitForLoadState("load");
  const priceForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add price" }) });
  await priceForm.getByLabel("Channel").selectOption("TAKEAWAY");
  await priceForm.getByLabel(/^Price/).fill("20");
  await priceForm.getByRole("button", { name: "Add price" }).click();
  await expect(page.getByRole("cell", { name: /EGP\s?20\.00/ })).toBeVisible();
  await page.goto(`/o/${slug}/pos/floors`);
  await page.getByLabel("Floor name").fill("Main hall");
  await page.getByLabel("Kitchen stock warehouse").selectOption({ label: "KIT — Kitchen" });
  await page.getByRole("button", { name: "Add floor" }).click();
  await expect(page.getByTestId("floor-Main hall")).toBeVisible();

  // A web page for pick-up and a kiosk that sends orders straight to the kitchen.
  await page.goto(`/o/${slug}/pos/online/setup`);
  await expect(page.getByText("No pages or kiosks yet.")).toBeVisible();
  const addChannel = async (
    kind: "WEB" | "KIOSK",
    name: string,
    eatIn: boolean,
    autoSend: boolean,
  ) => {
    await page.getByLabel("Type").selectOption(kind);
    await page.getByLabel("Name", { exact: true }).fill(name);
    if (eatIn) await page.getByRole("checkbox", { name: "Eat in" }).check();
    if (autoSend) await page.getByLabel(/Send orders to the kitchen at once/).check();
    await page.getByRole("button", { name: "Add a page or kiosk" }).click();
    await expect(page.getByTestId("ordering-channel").filter({ hasText: name })).toBeVisible();
  };
  await addChannel("WEB", "Pick-up online", false, false);
  await addChannel("KIOSK", "Kiosk 1", true, true);
  const address = (name: string) =>
    page
      .getByTestId("ordering-channel")
      .filter({ hasText: name })
      .getByLabel("Address")
      .inputValue();
  const webPath = new URL(await address("Pick-up online")).pathname;
  const kioskPath = new URL(await address("Kiosk 1")).pathname;

  // The guest, not signed in.
  const guest = await browser.newContext();
  const g = await guest.newPage();
  await g.goto(webPath);
  await g.getByRole("button", { name: /Cola/ }).first().click();
  await g.getByRole("button", { name: /Cola/ }).first().click();
  await expect(g.getByTestId("guest-total")).toHaveText(/EGP\s?40\.00/);
  await g.getByLabel("Your name").fill("Sara");
  await g.getByRole("button", { name: "Place order" }).click();
  await expect(g.getByText("Enter your mobile number.")).toBeVisible();
  await g.getByLabel("Mobile number").fill("0501234567");
  await g.getByRole("button", { name: "Place order" }).click();
  await expect(g.getByTestId("guest-order-number")).toHaveText(/^TAB-/);
  await g.getByRole("link", { name: "Follow your order" }).click();
  await expect(g.getByTestId("guest-order-state")).toContainText("Received");

  // The branch accepts it: it goes to the kitchen and the guest sees it.
  await page.goto(`/o/${slug}/pos/online`);
  const card = page.getByTestId("guest-order").filter({ hasText: "Sara" });
  await expect(card).toContainText("New");
  await expect(card).toContainText("+966501234567");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toContainText("In the kitchen");
  await g.reload();
  await expect(g.getByTestId("guest-order-state")).toContainText("Being prepared");

  // A kiosk order: eat in, no phone, straight to the kitchen; the kiosk is ready for the next guest.
  const k = await guest.newPage();
  await k.goto(kioskPath);
  await k.getByRole("tab", { name: "Eat in" }).click();
  await k.getByRole("button", { name: /Cola/ }).first().click();
  await expect(k.getByTestId("guest-total")).toHaveText(/EGP\s?25\.00/);
  await k.getByLabel("Your name").fill("Omar");
  await k.getByRole("button", { name: "Place order" }).click();
  await expect(k.getByTestId("guest-order-number")).toHaveText(/^TAB-/);
  await k.getByRole("button", { name: "New order" }).click();
  await expect(k.getByText("Choose items from the menu.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("guest-order").filter({ hasText: "Omar" })).toContainText(
    "In the kitchen",
  );

  await guest.close();
  await context.close();
});
