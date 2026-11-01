import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Store apps for the Food Ambassador web app (DECISIONS.md ADR-061).
 *
 * The apps load the hosted web app (`MOBILE_SERVER_URL`); they ship no copy
 * of it, so every deployment reaches the apps at once and the service worker
 * keeps the till working offline (ADR-060). Both values are set per build:
 *
 *   MOBILE_SERVER_URL  https URL of the production web app
 *   MOBILE_APP_ID      reverse-DNS app id, permanent once published
 *
 * The defaults only make debug builds possible; release builds refuse them
 * (scripts/configure.mjs).
 */
const serverUrl = process.env.MOBILE_SERVER_URL ?? "https://app.example.invalid";
const appId = process.env.MOBILE_APP_ID ?? "com.example.foodambassador";

const url = new URL(serverUrl);
if (url.protocol !== "https:") throw new Error("MOBILE_SERVER_URL must use https");

const config: CapacitorConfig = {
  appId,
  appName: "Food Ambassador",
  webDir: "www",
  // Lets the web app tell it runs inside a store app (e.g. for printing later).
  appendUserAgent: "FoodAmbassadorApp/1",
  backgroundColor: "#f6f7f5",
  server: {
    url: url.origin,
    cleartext: false,
    // Only the web app's own host opens inside the app; other links open in the browser.
    allowNavigation: [url.host],
    // Shown when the web app cannot be reached and nothing is cached yet.
    errorPath: "offline.html",
  },
  ios: {
    // App-bound domains: required for service workers (offline till) in WKWebView.
    limitsNavigationsToAppBoundDomains: true,
    contentInset: "automatic",
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
