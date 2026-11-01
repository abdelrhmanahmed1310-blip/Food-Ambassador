"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { countForRegister } from "./queue";

/**
 * Warns before a shift is closed while this device still holds orders for
 * the register that have not reached the server (ADR-060). Orders synced
 * after the close are still recorded in the shift and shown on its Z report.
 */
export function PendingSyncNotice({ registerId }: { registerId: string }) {
  const t = useTranslations();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const check = () =>
      countForRegister(registerId)
        .then((n) => alive && setCount(n))
        .catch(() => undefined);
    const first = window.setTimeout(check, 0);
    const timer = window.setInterval(check, 10_000);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [registerId]);
  if (count === 0) return null;
  return (
    <p
      role="alert"
      className="bg-warning-surface rounded px-3 py-2 text-sm"
      data-testid="pending-sync"
    >
      {t("pos.pendingBeforeClose", { count })}
    </p>
  );
}
