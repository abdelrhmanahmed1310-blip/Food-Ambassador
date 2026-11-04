"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm } from "@/components/forms/fields";
import { buttonClass } from "@/components/ui/styles";
import { normalizeScan } from "@/modules/wms/barcode";
import { CameraScanner } from "./scan-input";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface PickStep {
  id: string;
  locationCode: string | null;
  sku: string;
  name: string;
  barcodes: string[];
  lotCode: string | null;
  planned: string;
  unit: string;
}

type Phase = "location" | "product" | "quantity";

/**
 * Guided picking (ADR-104): for each line in walk order, scan the location,
 * then the product (barcode, SKU or lot), then confirm the quantity. Wrong
 * scans are refused on the spot; the result is submitted as one pick.
 */
export function PickScanner({ steps, action }: { steps: PickStep[]; action: Action }) {
  const t = useTranslations("scan");
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>(steps[0]?.locationCode ? "location" : "product");
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [results, setResults] = useState<Record<string, { picked: string; reason: string }>>({});
  const field = useRef<HTMLInputElement>(null);
  const qty = useRef<HTMLInputElement>(null);
  const reason = useRef<HTMLInputElement>(null);
  const step = steps[index];

  const advance = () => {
    const next = index + 1;
    setIndex(next);
    setPhase(steps[next]?.locationCode ? "location" : "product");
    setError(null);
  };
  const check = (raw: string) => {
    const code = normalizeScan(raw);
    if (!code || !step) return;
    if (phase === "location") {
      if (code.toUpperCase() === step.locationCode) {
        setPhase("product");
        setError(null);
      } else setError(t("wrongLocation", { expected: step.locationCode ?? "", got: code }));
    } else if (phase === "product") {
      const ok =
        code.toUpperCase() === step.sku ||
        step.barcodes.includes(code) ||
        (step.lotCode !== null && code === step.lotCode);
      if (ok) {
        setPhase("quantity");
        setError(null);
      } else setError(t("wrongProduct", { expected: step.sku, got: code }));
    }
    if (field.current) {
      field.current.value = "";
      field.current.focus();
    }
  };
  const onScan = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    check(field.current?.value ?? "");
  };
  const onQuantity = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const picked = (qty.current?.value ?? "").trim() || step.planned;
    const why = (reason.current?.value ?? "").trim();
    if (
      Number.isNaN(Number(picked)) ||
      Number(picked) < 0 ||
      Number(picked) > Number(step.planned)
    ) {
      setError(t("badQuantity", { planned: `${step.planned} ${step.unit}` }));
      return;
    }
    if (Number(picked) < Number(step.planned) && !why) {
      setError(t("shortNeedsReason"));
      return;
    }
    setResults((r) => ({ ...r, [step.id]: { picked, reason: why } }));
    advance();
  };

  if (!step)
    return (
      <div className="space-y-4">
        <p className="text-sm font-medium">{t("allScanned")}</p>
        <ul className="text-sm">
          {steps.map((s) => (
            <li key={s.id}>
              {s.locationCode ?? "—"} · {s.sku}: {results[s.id]?.picked} {s.unit}
            </li>
          ))}
        </ul>
        <ActionForm action={action} submitLabel={t("submitPick")} pendingLabel={t("saving")}>
          {steps.map((s, i) => (
            <span key={s.id}>
              <input type="hidden" name={`lines.${i}.id`} value={s.id} />
              <input
                type="hidden"
                name={`lines.${i}.pickedQuantity`}
                value={results[s.id]?.picked ?? "0"}
              />
              <input
                type="hidden"
                name={`lines.${i}.shortReason`}
                value={results[s.id]?.reason ?? ""}
              />
            </span>
          ))}
        </ActionForm>
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">{t("stepOf", { step: index + 1, total: steps.length })}</p>
      <div className="border-border rounded-lg border p-4">
        <p className="text-2xl font-semibold" data-testid="pick-location">
          {step.locationCode ?? t("noLocation")}
        </p>
        <p className="text-lg">
          {step.sku} — {step.name}
        </p>
        {step.lotCode ? <p className="text-muted font-mono">{step.lotCode}</p> : null}
        <p className="text-lg font-medium">
          {step.planned} {step.unit}
        </p>
      </div>
      {error ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}
      {phase === "quantity" ? (
        <form onSubmit={onQuantity} className="space-y-3" key={`q-${step.id}`}>
          <label className="block text-sm font-medium" htmlFor="pick-qty">
            {t("pickedQuantity", { unit: step.unit })}
          </label>
          <input
            ref={qty}
            id="pick-qty"
            defaultValue={step.planned}
            inputMode="decimal"
            dir="ltr"
            autoFocus
            className="border-border bg-surface w-full rounded-lg border px-3 py-3 text-lg"
          />
          <label className="block text-sm font-medium" htmlFor="pick-reason">
            {t("shortReason")}
          </label>
          <input
            ref={reason}
            id="pick-reason"
            className="border-border bg-surface w-full rounded-lg border px-3 py-2"
          />
          <button type="submit" className={buttonClass("primary")}>
            {t("next")}
          </button>
        </form>
      ) : (
        <form onSubmit={onScan} className="space-y-2" key={`${phase}-${step.id}`}>
          <label className="block text-sm font-medium" htmlFor="pick-scan">
            {phase === "location" ? t("scanLocation") : t("scanProduct")}
          </label>
          <input
            ref={field}
            id="pick-scan"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            autoFocus
            className="border-border bg-surface w-full rounded-lg border px-3 py-3 font-mono text-lg"
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass("primary")}>
              {t("check")}
            </button>
            {camera ? null : <CameraToggle onOpen={() => setCamera(true)} />}
          </div>
          {camera ? (
            <CameraScanner
              onClose={() => setCamera(false)}
              onCode={(code) => {
                setCamera(false);
                check(code);
              }}
            />
          ) : null}
        </form>
      )}
    </div>
  );
}

function CameraToggle({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations("scan");
  const [can, setCan] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setCan("BarcodeDetector" in window && !!navigator.mediaDevices), 0);
    return () => clearTimeout(id);
  }, []);
  if (!can) return null;
  return (
    <button type="button" className={buttonClass("secondary")} onClick={onOpen}>
      {t("useCamera")}
    </button>
  );
}
