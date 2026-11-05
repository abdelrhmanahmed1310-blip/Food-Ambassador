import { useLocale } from "next-intl";

/**
 * The Food Ambassador logo in the interface language: English
 * (public/brand/logo-en.webp) or Arabic (public/brand/logo-ar.webp), both
 * 512×512. Its alt text is the app name in that language.
 */
export function Logo({ className = "h-12 w-auto" }: { className?: string }) {
  const ar = useLocale() === "ar";
  return (
    // A plain <img>: a small fixed asset, no image optimizer needed.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={ar ? "/brand/logo-ar.webp" : "/brand/logo-en.webp"}
      alt={ar ? "سفير الأكل" : "Food Ambassador"}
      width={512}
      height={512}
      className={className}
    />
  );
}
