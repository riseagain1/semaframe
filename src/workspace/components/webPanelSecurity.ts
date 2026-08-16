import {
  detectUrlCapabilityRisk,
} from "../security/urlCapabilitySecurity";

export type ResolvedWebPanelSource =
  | Readonly<{
    ok: true;
    normalizedUrl: string;
    origin: string;
    hostname: string;
  }>
  | Readonly<{
    ok: false;
    reason: string;
  }>;

const MAX_WEB_PANEL_URL_LENGTH = 8_192;
const SENSITIVE_QUERY_TOKENS = new Set([
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "jwt",
  "password",
  "secret",
  "session",
  "sig",
  "signature",
  "signed",
  "token",
]);
const SENSITIVE_QUERY_SEQUENCES = new Set([
  "access_token",
  "api_key",
  "auth_token",
  "client_secret",
  "id_token",
  "private_key",
  "refresh_token",
  "session_id",
  "session_key",
  "session_token",
]);
const SECRET_LIKE_VALUE = /^(?:bearer|basic)\s+\S{8,}$|^(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}$|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/iu;
const JWT_LIKE_VALUE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
const SPECIAL_USE_HOST_SUFFIXES = [
  ".alt",
  ".example",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localdomain",
  ".localnet",
  ".localhost",
  ".onion",
  ".test",
] as const;

/**
 * Reject obvious non-public destinations and recognized authorization
 * capability patterns before a URL can be persisted. String inspection cannot
 * prove that an arbitrary hostname resolves publicly or that every opaque path
 * is benign, so activation remains an explicit local user decision. This is
 * shared by UI validation and the authoritative Store path used for both user
 * and Agent commands.
 */
export function resolveWebPanelSource(rawSource: string): ResolvedWebPanelSource {
  const source = rawSource.trim();
  if (!source || source.length > MAX_WEB_PANEL_URL_LENGTH) {
    return invalid("The website URL is empty or too long.");
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return invalid("Enter a complete HTTPS website URL.");
  }
  if (url.protocol !== "https:") return invalid("Only HTTPS website URLs can be embedded.");
  if (!url.hostname) return invalid("The website URL must include a hostname.");
  if (url.username || url.password) {
    return invalid("URLs containing usernames or passwords cannot be saved.");
  }
  if (url.port) return invalid("Custom network ports cannot be embedded in a website panel.");
  if (!isObviouslyPublicHostname(url.hostname)) {
    return invalid("Local, private, link-local, and special-use website hosts cannot be embedded.");
  }

  for (const [key, value] of url.searchParams) {
    if (
      isSensitiveQueryKey(key)
      || isSecretLikeValue(value)
    ) {
      return invalid("Credential, token, signature, and session query parameters cannot be saved.");
    }
  }
  if (url.hash.length > 1) {
    const rawFragment = decodeRepeated(url.hash.slice(1));
    if (JWT_LIKE_VALUE.test(rawFragment) || SECRET_LIKE_VALUE.test(rawFragment)) {
      return invalid("Credential, token, signature, and session URL fragments cannot be saved.");
    }
    const fragmentParams = new URLSearchParams(rawFragment);
    for (const [key, value] of fragmentParams) {
      if (
        isSensitiveQueryKey(key)
        || isSecretLikeValue(value)
      ) {
        return invalid("Credential, token, signature, and session URL fragments cannot be saved.");
      }
    }
  }
  const capabilityRisk = detectUrlCapabilityRisk(url);
  if (capabilityRisk === "query") {
    return invalid("Credential, token, signature, and session query parameters cannot be saved.");
  }
  if (capabilityRisk === "fragment") {
    return invalid("Credential, token, login, invitation, verification, and reset URL fragments cannot be saved.");
  }
  if (capabilityRisk === "path") {
    return invalid("Login, invitation, verification, and reset capability URLs cannot be saved.");
  }

  return {
    ok: true,
    normalizedUrl: url.toString(),
    origin: url.origin,
    hostname: url.hostname,
  };
}

function isSensitiveQueryKey(key: string): boolean {
  let candidate = key;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isNormalizedSensitiveQueryKey(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return false;
}

function isNormalizedSensitiveQueryKey(key: string): boolean {
  const normalized = normalizeIdentifier(key);
  if (SENSITIVE_QUERY_SEQUENCES.has(normalized)) return true;
  const tokens = normalized.split("_").filter(Boolean);
  if (tokens.some((token) => SENSITIVE_QUERY_TOKENS.has(token))) return true;
  const collapsed = tokens.join("");
  return [...SENSITIVE_QUERY_SEQUENCES].some((sequence) => collapsed.endsWith(sequence.replace(/_/gu, "")));
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isSecretLikeValue(value: string): boolean {
  const candidate = decodeRepeated(value.trim());
  return SECRET_LIKE_VALUE.test(candidate) || JWT_LIKE_VALUE.test(candidate);
}

function decodeRepeated(value: string): string {
  let candidate = value;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return candidate;
}

function isObviouslyPublicHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (!hostname || hostname === "localhost" || SPECIAL_USE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return false;
  }
  const ipv4 = parseIPv4(hostname);
  if (ipv4) return isPublicIPv4(ipv4);
  const ipv6 = parseIPv6(hostname);
  if (ipv6) return isPublicIPv6(ipv6);
  // Public web names are fully-qualified. Single-label names are resolved via
  // local search domains and therefore cannot satisfy this boundary.
  return hostname.includes(".");
}

function parseIPv4(hostname: string): readonly [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets as unknown as readonly [number, number, number, number];
}

function isPublicIPv4([first, second, third]: readonly [number, number, number, number]): boolean {
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function parseIPv6(hostname: string): readonly number[] | null {
  if (!hostname.includes(":")) return null;
  if ((hostname.match(/::/gu) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = hostname.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!hostname.includes("::") && missing !== 0)) return null;
  const groups = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return groups.length === 8 ? groups : null;
}

function isPublicIPv6(groups: readonly number[]): boolean {
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  // Currently allocated global-unicast IPv6 space is within 2000::/3. Direct
  // literals outside that range are special-use, translation, local, or
  // reserved addresses and are not suitable for this persisted public target.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  return true;
}

function invalid(reason: string): ResolvedWebPanelSource {
  return { ok: false, reason };
}
