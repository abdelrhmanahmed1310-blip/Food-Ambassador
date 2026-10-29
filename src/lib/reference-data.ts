/** Selectable currencies and time zones, labelled in the active locale. */
const COMMON_CURRENCIES = [
  "EGP",
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "BHD",
  "OMR",
  "JOD",
  "MAD",
  "USD",
  "EUR",
  "GBP",
];

export function currencyOptions(locale: string): Array<{ value: string; label: string }> {
  const names = new Intl.DisplayNames([locale], { type: "currency" });
  const all = Intl.supportedValuesOf("currency");
  const rest = all.filter((c) => !COMMON_CURRENCIES.includes(c));
  return [...COMMON_CURRENCIES, ...rest].map((code) => ({
    value: code,
    label: `${code} — ${names.of(code) ?? code}`,
  }));
}

const COMMON_TIME_ZONES = [
  "Africa/Cairo",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Amman",
  "Africa/Casablanca",
  "Europe/London",
  "UTC",
];

export function timeZoneOptions(): Array<{ value: string; label: string }> {
  const all = Intl.supportedValuesOf("timeZone").filter((tz) => !COMMON_TIME_ZONES.includes(tz));
  return [...COMMON_TIME_ZONES, ...all].map((tz) => ({
    value: tz,
    label: tz.replaceAll("_", " "),
  }));
}
