export const XR_PAIRING_FRAGMENT_KEY = "pair" as const;

type XrEntryLocation = Readonly<Pick<Location, "hash" | "origin" | "pathname" | "search">>;
type XrEntryHistory = Readonly<Pick<History, "replaceState" | "state">>;

/**
 * Reads and synchronously removes the one-time fragment credential.
 * URL fragments are not sent by HTTP, and this helper performs no persistence.
 */
export function takeXrPairingToken(
  location: XrEntryLocation,
  history: XrEntryHistory,
): string | undefined {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const parameters = new URLSearchParams(fragment);
  const pairingToken = parameters.get(XR_PAIRING_FRAGMENT_KEY)?.trim() || undefined;
  if (!parameters.has(XR_PAIRING_FRAGMENT_KEY)) return undefined;

  parameters.delete(XR_PAIRING_FRAGMENT_KEY);
  const remainingFragment = parameters.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${remainingFragment ? `#${remainingFragment}` : ""}`,
  );
  return pairingToken;
}

/** Normalizes an optional deployment value to the exact transport origin. */
export function resolveXrGatewayOrigin(
  configured: string | undefined,
  location: Pick<XrEntryLocation, "origin">,
): string {
  const candidate = configured?.trim();
  if (!candidate) return location.origin;

  const url = new URL(candidate);
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash) {
    throw new Error("VITE_XR_GATEWAY_ORIGIN must be an HTTP(S) origin without credentials, a path, a query, or a fragment.");
  }
  return url.origin;
}
