export type UrlCapabilityRisk = "query" | "path" | "fragment";

const CAPABILITY_QUERY_KEYS = new Set([
  "authorization_code",
  "code",
  "login_code",
  "oauth_code",
  "ticket",
  "verification_code",
]);

const CAPABILITY_PATH_MARKERS = new Set([
  "activate",
  "activate_account",
  "activation",
  "callback",
  "email_verification",
  "invite",
  "login",
  "magic_link",
  "magic_login",
  "password_reset",
  "reset",
  "reset_password",
  "signin",
  "token",
  "verify",
  "verify_email",
]);

const JWT_LIKE_VALUE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;
const FRAGMENT_CREDENTIAL_KEYS = new Set([
  "access_token",
  "auth_token",
  "authorization",
  "bearer",
  "client_secret",
  "credential",
  "id_token",
  "password",
  "refresh_token",
  "secret",
  "session_token",
  "token",
]);
const MAX_NESTED_CAPABILITY_DEPTH = 4;
const MAX_NESTED_CAPABILITY_URLS = 64;
const MAX_NESTED_CAPABILITY_VALUE_CHARACTERS = 8_192;

type CapabilityScanContext = {
  remainingUrls: number;
};

/**
 * Detect an authorization capability embedded in a URL without treating an
 * ordinary readable route such as `/login/enterprise-dashboard` as a secret.
 * The same pure policy is used at browser input, server fetch, redirect, and
 * durable-resource boundaries so canonicalization cannot weaken it.
 */
export function detectUrlCapabilityRisk(url: URL): UrlCapabilityRisk | null {
  return detectUrlCapabilityRiskInternal(url, {
    remainingUrls: MAX_NESTED_CAPABILITY_URLS,
  }, 0);
}

function detectUrlCapabilityRiskInternal(
  url: URL,
  context: CapabilityScanContext,
  depth: number,
): UrlCapabilityRisk | null {
  const queryRisk = detectParameterCapabilityRisk(url.searchParams, context, depth, false)
    ?? (url.search.includes(";")
      ? detectParameterCapabilityRisk(
        new URLSearchParams(url.search.slice(1).replace(/;/gu, "&")),
        context,
        depth,
        false,
      )
      : null);
  if (queryRisk) return "query";
  if (hasOpaqueUrlCapabilityPath(url.pathname)) return "path";
  return url.hash.length > 1 && fragmentContainsCapability(url.hash.slice(1), context, depth)
    ? "fragment"
    : null;
}

function detectParameterCapabilityRisk(
  parameters: URLSearchParams,
  context: CapabilityScanContext,
  depth: number,
  includeCredentialKeys: boolean,
): UrlCapabilityRisk | null {
  for (const [key, value] of parameters) {
    if (isUrlCapabilityQueryPair(key, value)) return "query";
    const normalizedKey = normalizeIdentifier(decodeRepeated(key));
    if (includeCredentialKeys && FRAGMENT_CREDENTIAL_KEYS.has(normalizedKey) && decodeRepeated(value.trim())) {
      return "fragment";
    }
    if (nestedValueContainsCapability(value, context, depth + 1)) return "query";
  }
  return null;
}

function fragmentContainsCapability(
  rawFragment: string,
  context: CapabilityScanContext,
  depth: number,
): boolean {
  const fragment = decodeRepeated(rawFragment.trim());
  if (!fragment) return false;
  if (fragment.length > MAX_NESTED_CAPABILITY_VALUE_CHARACTERS) return true;

  const route = fragment.replace(/^!/u, "");
  const queryIndex = route.indexOf("?");
  const queryText = route.startsWith("?")
    ? route.slice(1)
    : queryIndex >= 0
      ? route.slice(queryIndex + 1)
      : route;
  const parameterRisk = detectParameterCapabilityRisk(
    new URLSearchParams(queryText.replace(/;/gu, "&")),
    context,
    depth,
    true,
  );
  if (parameterRisk) return true;

  try {
    const routeUrl = new URL(route, "https://fragment.invalid/");
    if (routeUrl.origin === "https://fragment.invalid") {
      if (hasOpaqueUrlCapabilityPath(routeUrl.pathname)) return true;
    } else if (detectUrlCapabilityRiskInternal(routeUrl, context, depth + 1)) {
      return true;
    }
  } catch {
    // A malformed fragment route is not itself an authorization capability.
  }
  return nestedValueContainsCapability(fragment, context, depth + 1);
}

function nestedValueContainsCapability(
  value: string,
  context: CapabilityScanContext,
  depth: number,
): boolean {
  const candidate = decodeRepeated(value.trim());
  if (!candidate) return false;
  if (candidate.length > MAX_NESTED_CAPABILITY_VALUE_CHARACTERS) return true;
  let nested: URL;
  try {
    nested = new URL(candidate);
  } catch {
    return false;
  }
  if (nested.protocol !== "http:" && nested.protocol !== "https:") return false;
  if (depth > MAX_NESTED_CAPABILITY_DEPTH || context.remainingUrls <= 0) return true;
  context.remainingUrls -= 1;
  return detectUrlCapabilityRiskInternal(nested, context, depth) !== null;
}

/** Also used for query-shaped URL fragments in website panels. */
export function isUrlCapabilityQueryPair(key: string, value: string): boolean {
  const normalizedKey = normalizeIdentifier(decodeRepeated(key));
  if (!CAPABILITY_QUERY_KEYS.has(normalizedKey)) return false;
  const candidate = decodeRepeated(value.trim());
  // Six decimal digits are commonly one-time verification capabilities. Long
  // URL-safe values cover OAuth codes/tickets while keeping `?code=US` valid.
  return /^\d{6,}$/u.test(candidate)
    || (candidate.length >= 16
      && !/\s/u.test(candidate)
      && /^[A-Za-z0-9._~+/=-]+$/u.test(candidate));
}

export function hasOpaqueUrlCapabilityPath(pathname: string): boolean {
  const segments = decodeRepeated(pathname)
    .split("/")
    .filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const marker = normalizeIdentifier(segments[index] ?? "");
    const candidate = segments[index + 1] ?? "";
    if (CAPABILITY_PATH_MARKERS.has(marker) && looksOpaqueCapability(candidate)) return true;
  }
  return false;
}

function looksOpaqueCapability(value: string): boolean {
  const candidate = decodeRepeated(value.trim()).split(";", 1)[0] ?? "";
  if (/^\d{6,}$/u.test(candidate)) return true;
  if (/^[0-9a-f]{24,}$/iu.test(candidate)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)) {
    return true;
  }
  if (JWT_LIKE_VALUE.test(candidate)) return true;
  if (candidate.length < 16 || /\s/u.test(candidate) || !/^[A-Za-z0-9._~+/=-]+$/u.test(candidate)) {
    return false;
  }
  // Preserve ordinary human-readable routes while rejecting opaque capability
  // material. The separator form intentionally allows slugs with many words.
  if (/^[A-Za-z]+(?:[-_][A-Za-z]+)+$/u.test(candidate)) return false;
  return true;
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
