import { describe, expect, it, vi } from "vitest";
import { resolveXrGatewayOrigin, takeXrPairingToken } from "../../xr/entry";

function location(overrides: Partial<Location> = {}): Location {
  return {
    hash: "",
    origin: "https://viewer.example",
    pathname: "/xr.html",
    search: "",
    ...overrides,
  } as Location;
}

describe("XR standalone entry security", () => {
  it("takes the fragment token and scrubs it before the caller can use it", () => {
    const replaceState = vi.fn();
    const token = takeXrPairingToken(
      location({ hash: "#panel=compact&pair=one_time_secret&theme=dark", search: "?safe=1" }),
      { state: { safe: true }, replaceState },
    );

    expect(token).toBe("one_time_secret");
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(
      { safe: true },
      "",
      "/xr.html?safe=1#panel=compact&theme=dark",
    );
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain("one_time_secret");
  });

  it("scrubs an empty or duplicate pairing field and never preserves it", () => {
    const replaceState = vi.fn();
    expect(takeXrPairingToken(
      location({ hash: "#pair=&pair=another" }),
      { state: null, replaceState },
    )).toBeUndefined();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/xr.html");
  });

  it("keeps the same origin by default and normalizes a configured origin", () => {
    expect(resolveXrGatewayOrigin(undefined, location())).toBe("https://viewer.example");
    expect(resolveXrGatewayOrigin(" https://relay.example:9443/ ", location()))
      .toBe("https://relay.example:9443");
  });

  it.each([
    "wss://relay.example",
    "https://user:secret@relay.example",
    "https://relay.example/api/xr",
    "https://relay.example?token=secret",
    "https://relay.example/#fragment",
  ])("rejects a non-origin gateway value: %s", (configured) => {
    expect(() => resolveXrGatewayOrigin(configured, location())).toThrow(
      "VITE_XR_GATEWAY_ORIGIN must be an HTTP(S) origin",
    );
  });
});
