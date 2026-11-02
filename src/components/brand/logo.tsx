/** The Food Ambassador logo (public/brand/logo.webp, 635×274). Its alt text is the app name. */
export function Logo({ className = "h-9 w-auto" }: { className?: string }) {
  return (
    // A plain <img>: a small fixed asset, no image optimizer needed.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/logo.webp"
      alt="Food Ambassador"
      width={635}
      height={274}
      className={className}
    />
  );
}
