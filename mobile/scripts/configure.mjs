// Applies the build's server URL to the native projects (ADR-061).
// Release builds (MOBILE_RELEASE=1) refuse the placeholder URL and app id.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const serverUrl = process.env.MOBILE_SERVER_URL ?? "https://app.example.invalid";
const appId = process.env.MOBILE_APP_ID ?? "com.example.foodambassador";
const url = new URL(serverUrl);
if (url.protocol !== "https:") throw new Error("MOBILE_SERVER_URL must use https");
if (process.env.MOBILE_RELEASE === "1") {
  if (url.hostname.endsWith(".invalid"))
    throw new Error("Set MOBILE_SERVER_URL for a release build");
  if (appId.startsWith("com.example.")) throw new Error("Set MOBILE_APP_ID for a release build");
}

// iOS: the web app's host is the app-bound domain (service workers need it).
const plist = "ios/App/App/Info.plist";
if (existsSync(plist)) {
  let text = readFileSync(plist, "utf8");
  const entry = `\t<key>WKAppBoundDomains</key>\n\t<array>\n\t\t<string>${url.hostname}</string>\n\t</array>\n`;
  if (text.includes("<key>WKAppBoundDomains</key>"))
    text = text.replace(/\t<key>WKAppBoundDomains<\/key>\n\t<array>[\s\S]*?<\/array>\n/, entry);
  else text = text.replace(/<\/dict>\s*<\/plist>\s*$/, `${entry}</dict>\n</plist>\n`);
  writeFileSync(plist, text);
}
// iOS: the bundle id (Android takes it as a Gradle property, -PappId).
const pbxproj = "ios/App/App.xcodeproj/project.pbxproj";
if (existsSync(pbxproj)) {
  const text = readFileSync(pbxproj, "utf8").replace(
    /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
  );
  writeFileSync(pbxproj, text);
}

console.log(`Server ${url.origin}, app id ${appId}`);
