"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Draw a signature with a finger, stylus or mouse (ADR-116). The strokes
 * are kept as SVG path data (move and line commands only) in a hidden
 * field named `signature`.
 */
export function SignaturePad() {
  const t = useTranslations("logistics");
  const [path, setPath] = useState("");
  const drawing = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 300);
    const y = Math.round(((e.clientY - r.top) / r.height) * 120);
    return `${Math.max(0, Math.min(300, x))} ${Math.max(0, Math.min(120, y))}`;
  };
  return (
    <div>
      <span className="mb-1 block text-sm font-medium">{t("signature")}</span>
      <svg
        ref={svg}
        viewBox="0 0 300 120"
        className="border-border bg-surface h-32 w-full max-w-sm touch-none rounded-lg border"
        role="img"
        aria-label={t("signatureArea")}
        data-testid="signature-pad"
        onPointerDown={(e) => {
          drawing.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          setPath((p) => `${p} M ${point(e)}`.trim());
        }}
        onPointerMove={(e) => {
          if (drawing.current) setPath((p) => `${p} L ${point(e)}`);
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerLeave={() => (drawing.current = false)}
      >
        <path
          d={path || "M 0 0"}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      <input type="hidden" name="signature" value={path} />
      <button
        type="button"
        className="text-primary mt-1 text-xs hover:underline"
        onClick={() => setPath("")}
      >
        {t("clearSignature")}
      </button>
    </div>
  );
}

/** A stored signature, drawn back from its path data (validated on save). */
export function SignatureView({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 300 120" className="border-border h-20 w-48 rounded border" role="img">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
