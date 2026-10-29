/** Shared class names so links and buttons look identical. */
export const buttonStyles = {
  base: "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "border border-border bg-surface text-foreground hover:bg-surface-muted",
  danger: "border border-danger/40 bg-surface text-danger hover:bg-danger-surface",
  ghost: "text-foreground hover:bg-surface-muted",
} as const;

export type ButtonVariant = Exclude<keyof typeof buttonStyles, "base">;

export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `${buttonStyles.base} ${buttonStyles[variant]} ${extra}`.trim();
}

export const inputClass =
  "block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted aria-[invalid=true]:border-danger";
