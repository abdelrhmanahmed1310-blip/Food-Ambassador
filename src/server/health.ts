export type CheckStatus = "ok" | "fail";

export interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
}

export interface ReadinessReport {
  status: "ok" | "unavailable";
  checks: Record<string, CheckResult>;
}

export type Probe = () => Promise<void>;

export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

async function runProbe(
  probe: Probe,
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<CheckResult> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    onError(error);
    return { status: "fail", latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run dependency probes concurrently. The report deliberately carries no error
 * messages (they may contain hostnames or credentials); failures go to `onError`
 * for server-side logging instead.
 */
export async function checkReadiness(
  probes: Record<string, Probe>,
  options: { timeoutMs?: number; onError?: (name: string, error: unknown) => void } = {},
): Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const entries = await Promise.all(
    Object.entries(probes).map(
      async ([name, probe]) =>
        [name, await runProbe(probe, timeoutMs, (e) => options.onError?.(name, e))] as const,
    ),
  );
  const checks = Object.fromEntries(entries);
  const status = entries.every(([, r]) => r.status === "ok") ? "ok" : "unavailable";
  return { status, checks };
}
