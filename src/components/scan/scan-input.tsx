"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useFormState } from "@/components/forms/fields";
import { buttonClass } from "@/components/ui/styles";

/** The browser's barcode reader (Chrome and Edge on Android, among others). */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "qr_code"];

function detectorClass(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

/**
 * The phone camera as a scanner: opens the rear camera and reports the
 * first barcode it reads. Shown only where the browser has a barcode reader.
 */
export function CameraScanner({
  onCode,
  onClose,
}: {
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("scan");
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const Detector = detectorClass();
    if (!Detector) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const detector = new Detector({ formats: FORMATS });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        void video.current.play();
        timer = setInterval(() => {
          if (done || !video.current || video.current.readyState < 2) return;
          detector
            .detect(video.current)
            .then((found) => {
              const value = found[0]?.rawValue;
              if (value && !done) {
                done = true;
                onCode(value);
              }
            })
            .catch(() => undefined);
        }, 250);
      })
      .catch(() => setError(t("cameraDenied")));
    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onCode, t]);
  return (
    <div className="border-border space-y-2 rounded-lg border p-2">
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : (
        <video ref={video} className="aspect-video w-full rounded bg-black" muted playsInline />
      )}
      <button type="button" className={buttonClass("secondary")} onClick={onClose}>
        {t("closeCamera")}
      </button>
    </div>
  );
}

/**
 * A field for scanning inside a form. Keyboard-style scanners type the code
 * and press Enter, which submits the form; the camera fills the field and
 * submits it. After each submission the field is emptied and focused again,
 * ready for the next scan.
 */
export function ScanInput({ name, label, hint }: { name: string; label: string; hint?: string }) {
  const t = useTranslations("scan");
  const state = useFormState();
  const input = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  const [canCamera, setCanCamera] = useState(false);
  useEffect(() => {
    const id = setTimeout(
      () => setCanCamera(detectorClass() !== null && !!navigator.mediaDevices),
      0,
    );
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!input.current) return;
    input.current.value = "";
    input.current.focus();
  }, [state.seq]);
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`scan-${name}`}>
        {label}
      </label>
      <input
        ref={input}
        id={`scan-${name}`}
        name={name}
        dir="ltr"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="go"
        autoFocus
        className="border-border bg-surface w-full rounded-lg border px-3 py-3 font-mono text-lg"
      />
      {hint ? <p className="text-muted text-xs">{hint}</p> : null}
      {canCamera ? (
        camera ? (
          <CameraScanner
            onClose={() => setCamera(false)}
            onCode={(code) => {
              setCamera(false);
              if (!input.current) return;
              input.current.value = code;
              input.current.form?.requestSubmit();
            }}
          />
        ) : (
          <button
            type="button"
            className={buttonClass("secondary")}
            onClick={() => setCamera(true)}
          >
            {t("useCamera")}
          </button>
        )
      ) : null}
    </div>
  );
}
