/** Server-side normalization for browser-reported UI errors (no secrets, bounded size). */

const SENSITIVE_KEY_RE =
  /(password|passwd|token|secret|authorization|cookie|set-cookie|cvv|cvc|pan|cardnumber|card-number|apikey|api-key|refresh|bearer|pin|ssn)/i;

const MAX_STR = 2000;
const MAX_STACK = 8000;
const MAX_PATH = 500;
const ALLOWED_TYPES = new Set(["window_error", "unhandled_rejection", "api_error", "manual"]);

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function sanitizeValue(v: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated-depth]";
  if (v === null || v === undefined) return v;
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return truncate(v, MAX_STR);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeValue(x, depth + 1));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (SENSITIVE_KEY_RE.test(k)) continue;
      out[k] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

export type ClientUiErrorPayload = {
  type?: string;
  message?: string;
  stack?: string;
  url?: string;
  pathname?: string;
  userAgent?: string;
  timestamp?: string;
  feature?: string;
  context?: Record<string, unknown>;
};

export function normalizeClientUiError(raw: unknown): ClientUiErrorPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" && ALLOWED_TYPES.has(r.type) ? r.type : "manual";
  const message = typeof r.message === "string" ? truncate(r.message, MAX_STR) : "";
  const stack = typeof r.stack === "string" ? truncate(r.stack, MAX_STACK) : undefined;
  const url = typeof r.url === "string" ? truncate(r.url, MAX_STR) : undefined;
  const pathname = typeof r.pathname === "string" ? truncate(r.pathname, MAX_PATH) : undefined;
  const userAgent = typeof r.userAgent === "string" ? truncate(r.userAgent, MAX_STR) : undefined;
  const timestamp = typeof r.timestamp === "string" ? truncate(r.timestamp, 64) : undefined;
  const feature = typeof r.feature === "string" ? truncate(r.feature, 200) : undefined;
  let context: Record<string, unknown> | undefined;
  if (r.context && typeof r.context === "object" && !Array.isArray(r.context)) {
    context = sanitizeValue(r.context, 0) as Record<string, unknown>;
  }
  return { type, message, stack, url, pathname, userAgent, timestamp, feature, context };
}

export function logClientUiError(payload: ClientUiErrorPayload): void {
  const line = JSON.stringify(payload);
  console.warn("[ui-error]", line.length > 16000 ? line.slice(0, 16000) + "…" : line);
}
