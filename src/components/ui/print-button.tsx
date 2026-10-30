"use client";

import { buttonClass } from "./styles";

export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className={`${buttonClass("secondary")} print:hidden`}
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}
