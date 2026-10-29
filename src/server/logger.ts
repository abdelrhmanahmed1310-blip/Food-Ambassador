import "server-only";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  fatal: 50,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

// Field names whose values must never reach log output, matched case-insensitively
// anywhere in the key (e.g. "passwordHash", "x-api-key", "sessionToken").
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[Truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

type Sink = (line: string, level: LogLevel) => void;

const defaultSink: Sink = (line, level) => {
  if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.error) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

/** Structured JSON-lines logger with secret redaction. */
export function createLogger(
  options: { level?: LogLevel; bindings?: LogFields; sink?: Sink } = {},
): Logger {
  const level = options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;

  const write = (lvl: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    const entry = redact({
      time: new Date().toISOString(),
      level: lvl,
      message,
      ...bindings,
      ...fields,
    });
    sink(JSON.stringify(entry), lvl);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    fatal: (m, f) => write("fatal", m, f),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra }, sink }),
  };
}

export const logger = createLogger();
