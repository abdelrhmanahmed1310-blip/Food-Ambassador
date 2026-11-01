# Store apps — build and release

Decision: DECISIONS.md ADR-061. The App Store and Google Play apps are
Capacitor shells (`mobile/`) that load the hosted web app. They contain no
copy of it: a web deployment reaches every app at once, and the service
worker (ADR-060) keeps the till working offline.

## What is needed from the organization (not in the repository)

| Item                                                               | Where                                                                                                    | Used for              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------- |
| Production web app URL                                             | Q-03 hosting decision; must be https                                                                     | `MOBILE_SERVER_URL`   |
| App id (reverse DNS)                                               | Chosen once, e.g. `com.<company>.foodambassador`; **cannot change after publishing**                     | `MOBILE_APP_ID`       |
| Google Play developer account                                      | play.google.com/console (one-time fee)                                                                   | Publishing on Android |
| Android upload key                                                 | Generated with `keytool`, kept in a password manager / CI secret; Play App Signing holds the release key | Signing uploads       |
| Apple Developer Program                                            | developer.apple.com (yearly fee), organization enrolment needs a D-U-N-S number                          | Publishing on iOS     |
| Apple distribution certificate and App Store provisioning profile  | Xcode → Settings → Accounts, or the developer portal                                                     | Signing iOS builds    |
| Privacy policy URL, support URL, screenshots, descriptions (EN/AR) | Store listings                                                                                           | Both stores' review   |

Nothing above is committed. Secrets go into CI secrets or the release
machine's keychain only.

## Every build

```bash
cd mobile
npm ci
MOBILE_SERVER_URL=https://<production host> MOBILE_APP_ID=<app id> MOBILE_RELEASE=1 npm run sync
```

`npm run sync` applies the URL (iOS app-bound domain, allowed navigation),
the iOS bundle id, and copies the config into both native projects.
`MOBILE_RELEASE=1` refuses the placeholder URL and app id.

## Android (Google Play)

```bash
cd mobile/android
./gradlew bundleRelease -PappId=<app id> -PversionCode=<n> -PversionName=<x.y.z>
```

Sign the bundle with the upload key (Android Studio → Build → Generate Signed
Bundle, or a `signingConfigs` block reading the key from environment
variables), then upload `app/build/outputs/bundle/release/app-release.aab` to
the Play Console. `versionCode` must increase on every upload.

## iOS (App Store)

On a Mac with the current Xcode: open `mobile/ios/App/App.xcodeproj`, choose
the team, set the version and build number, then Product → Archive →
Distribute App → App Store Connect. The app-bound domain in `Info.plist`
must be the production host (set by `npm run sync`).

Review note: Apple can refuse apps that only wrap a website (guideline 4.2).
Explain in the review notes that the app is a point-of-sale and back-office
client with offline selling, and provide a demo organization and login made
from the development seed — never real customer data.

## Checks on every change

`.github/workflows/mobile.yml` builds an Android debug APK (downloadable from
the workflow run) and an unsigned iOS simulator build whenever `mobile/`
changes. Installing the debug APK needs `MOBILE_SERVER_URL` set to a
reachable https host; the CI build uses a placeholder and shows the offline
page.

## Not yet in the store apps

- Printing: the in-app web views have no print dialog; print buttons say to
  print from the browser or the installed web app. Native receipt printing
  (Bluetooth / network ESC/POS) needs a printer plugin tested on the chosen
  hardware (Q-16 printers).
- Card terminals: POS3 (Q-15).
- Push notifications, barcode scanning with the camera.
