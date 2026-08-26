import type {
  XrNetworkFetch,
  XrNetworkTimerHandle,
  XrNetworkTimers,
} from "../../xr/network/contracts";
import {
  XR_RELAY_PROTOCOL_VERSION,
  type XrAckMessage,
  type XrDeltaMessage,
  type XrInputMessage,
  type XrReconnectCursor,
  type XrSnapshotMessage,
} from "../../xr/protocol";

export const TEST_ORIGIN = "https://xr-host.semaframe.test";
export const AUTHORITY_SESSION = "authority-session-0001";
export const VIEWER_SESSION = "renderer-session-0001";
export const AUTHORITY_EPOCH = "authority-epoch-0001";
export const WORKSPACE_ID = "workspace-network";
export const AUTHORITY_BEARER = Buffer.alloc(32, 31).toString("base64url");
export const VIEWER_BEARER = Buffer.alloc(32, 47).toString("base64url");
export const PAIRING_TOKEN = Buffer.alloc(32, 63).toString("base64url");
export const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
export const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
export const REGISTRY_DIGEST = `sha256:${"c".repeat(64)}` as const;

export function jsonSuccess(data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify({ ok: true, data });
  return new Response(body, {
    ...init,
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

export function jsonFailure(
  status: number,
  code: string,
  message = "Request failed.",
): Response {
  const body = JSON.stringify({ ok: false, error: { code, message } });
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

export function authorityConnection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: AUTHORITY_SESSION,
    role: "authority",
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    connectedAtMs: 1_000,
    sessionBearer: AUTHORITY_BEARER,
    ...extra,
  };
}

export function viewerConnection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: VIEWER_SESSION,
    role: "xr_renderer",
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    connectedAtMs: 1_001,
    sessionBearer: VIEWER_BEARER,
    pairingId: "pairing-id-0001",
    capabilities: { voiceRelay: true },
    ...extra,
  };
}

export function snapshot(
  sessionId = VIEWER_SESSION,
  revision = 4,
  digest: `sha256:${string}` = DIGEST_A,
  requestId = "snapshot-request-0001",
): XrSnapshotMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "snapshot",
    sessionId,
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    revision,
    requestId,
    registryDigest: REGISTRY_DIGEST,
    snapshotDigest: digest,
    snapshot: { revision, components: [] },
  };
}

export function delta(
  sessionId = VIEWER_SESSION,
  baseRevision = 4,
  revision = 5,
  baseDigest: `sha256:${string}` = DIGEST_A,
  digest: `sha256:${string}` = DIGEST_B,
): XrDeltaMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "delta",
    sessionId,
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    revision,
    requestId: `delta-request-${revision.toString().padStart(4, "0")}`,
    baseRevision,
    baseSnapshotDigest: baseDigest,
    snapshotDigest: digest,
    delta: { operations: [{ op: "replace", revision }] },
  };
}

export function input(
  sessionId = VIEWER_SESSION,
  revision = 4,
  requestId = "input-request-0001",
): XrInputMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "input",
    sessionId,
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    revision,
    requestId,
    inputType: "select",
    payload: { componentId: "CMP_NETWORK" },
  };
}

export function ack(
  sessionId: string,
  revision: number,
  requestId: string,
): XrAckMessage {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    messageType: "ack",
    sessionId,
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    revision,
    requestId,
    status: "accepted",
  };
}

export function cursor(
  revision = 4,
  digest: `sha256:${string}` = DIGEST_A,
  requestId = "reconnect-request-0001",
): XrReconnectCursor {
  return {
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    sessionId: VIEWER_SESSION,
    authorityEpoch: AUTHORITY_EPOCH,
    workspaceId: WORKSPACE_ID,
    revision,
    snapshotDigest: digest,
    requestId,
  };
}

type TimerEntry = Readonly<{ callback: () => void; delayMs: number }>;

export class ManualTimers implements XrNetworkTimers {
  #nextId = 1;
  readonly #entries = new Map<number, TimerEntry>();

  setTimeout(callback: () => void, delayMs: number): XrNetworkTimerHandle {
    const id = this.#nextId++;
    this.#entries.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: XrNetworkTimerHandle): void {
    this.#entries.delete(handle as number);
  }

  pendingDelays(): readonly number[] {
    return [...this.#entries.values()].map((entry) => entry.delayMs).sort((a, b) => a - b);
  }

  runNext(delayMs?: number): boolean {
    const selected = [...this.#entries.entries()]
      .filter(([, entry]) => delayMs === undefined || entry.delayMs === delayMs)
      .sort((left, right) => left[1].delayMs - right[1].delayMs || left[0] - right[0])[0];
    if (!selected) return false;
    this.#entries.delete(selected[0]);
    selected[1].callback();
    return true;
  }
}

export async function settle(turns = 32): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

export function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
  return new Request(input, init);
}

export type FetchRoute = (
  request: Request,
  body: Record<string, unknown> | undefined,
) => Response | Promise<Response>;

export function routedFetch(
  routes: Readonly<Record<string, FetchRoute>>,
  requests: Request[] = [],
): XrNetworkFetch {
  return async (inputValue, init) => {
    const request = requestOf(inputValue, init);
    requests.push(request.clone());
    const pathname = new URL(request.url).pathname;
    const route = routes[pathname];
    if (!route) return jsonFailure(404, "not_found");
    const body = request.method === "GET"
      || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      ? undefined
      : await request.clone().json() as Record<string, unknown>;
    return route(request, body);
  };
}
