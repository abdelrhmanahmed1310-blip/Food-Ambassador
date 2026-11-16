import { expect, test } from "@playwright/test";
import { newClient } from "./helpers";
import { openTill } from "./pos-setup";

test("POS simulator: punch and scan a test sale, pay cash with change, preview the menu board (ADR-135)", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await newClient(browser);
  const slug = await openTill(page, "pos-simulator");

  // A barcode on the product the Cola item is sold from, and a menu board.
  await page.goto(`/o/${slug}/catalog/products`);
  await page
    .getByRole("link", { name: /Cola can/ })
    .first()
    .click();
  await page.getByLabel("Barcode", { exact: true }).fill("6281000000014");
  await page.getByLabel("Barcode type").selectOption("EAN13");
  await page.getByRole("button", { name: "Add barcode" }).click();
  await expect(page.getByText("6281000000014")).toBeVisible();
  await page.goto(`/o/${slug}/pos/online/setup`);
  await page.getByLabel("Type").selectOption("BOARD");
  await page.getByLabel("Name", { exact: true }).fill("Front screen");
  await page.getByRole("checkbox", { name: "Eat in" }).check();
  await page.getByLabel("Colours").selectOption("DARK");
  await page.getByRole("button", { name: "Add a page or kiosk" }).click();
  await expect(
    page.getByTestId("ordering-channel").filter({ hasText: "Front screen" }),
  ).toBeVisible();

  // The simulator, from the POS menu.
  await page.goto(`/o/${slug}/pos`);
  await page.getByRole("link", { name: "POS simulator" }).click();
  await expect(page.getByTestId("simulation-banner")).toContainText("nothing is recorded");

  // Punch one Cola, then scan one with the keyboard field and one with the virtual scanner.
  await page.getByRole("button", { name: /Cola/ }).first().click();
  await expect(page.getByTestId("sim-total")).toHaveText(/EGP\s?25\.00/);
  const scan = page.getByLabel("Scan or type a barcode");
  await scan.fill("6281000000014");
  await scan.press("Enter");
  await expect(page.getByText(/Scanned 6281000000014/)).toBeVisible();
  await expect(page.getByTestId("sim-total")).toHaveText(/EGP\s?50\.00/);
  await page.getByLabel("Virtual scanner").selectOption("6281000000014");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByTestId("sim-total")).toHaveText(/EGP\s?75\.00/);
  await scan.fill("4000000000002");
  await scan.press("Enter");
  await expect(
    page.getByText("No item on this channel has the barcode 4000000000002."),
  ).toBeVisible();

  // Too little cash is refused; enough gives change and a simulation receipt.
  await page.getByLabel(/Cash tendered/).fill("50");
  await page.getByRole("button", { name: "Complete test sale" }).click();
  await expect(page.getByText("The cash tendered is less than the amount due.")).toBeVisible();
  await page.getByLabel(/Cash tendered/).fill("100");
  await page.getByRole("button", { name: "Complete test sale" }).click();
  const receipt = page.getByTestId("sim-receipt");
  await expect(receipt).toContainText("Simulation — not a tax invoice");
  await expect(page.getByTestId("sim-receipt-total")).toHaveText(/EGP\s?75\.00/);
  await expect(receipt).toContainText(/Change: EGP\s?25\.00/);

  // The session summary counts it as a mixed (punched and scanned) cash sale.
  await page.getByRole("tab", { name: /Session/ }).click();
  const session = page.getByTestId("sim-session");
  await expect(session).toContainText("Test sale #1");
  await expect(session).toContainText("Punched and scanned");

  // The menu board preview shows the board as the screen would, inline.
  await page.getByRole("tab", { name: "Menu board" }).click();
  const board = page.getByTestId("sim-board");
  await expect(board).toHaveAttribute("data-theme", "DARK");
  await expect(board.getByTestId("board-item").filter({ hasText: "Cola" })).toContainText(
    /EGP\s?25\.00/,
  );
  await expect(page.getByRole("link", { name: "Open full screen" })).toHaveAttribute(
    "href",
    /^\/board\/.+\?at=\d\d%3A\d\d$/,
  );

  await context.close();
});
