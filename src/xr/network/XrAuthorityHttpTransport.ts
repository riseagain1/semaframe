import type {
  XrAuthorityConnectionView,
  XrAuthorityPairingGrant,
  XrAuthorityPollDelivery,
  XrAuthorityTransport,
} from "../authority/XrAuthorityController";
import {
  XR_ASSET_LIMITS,
  XR_ASSET_MEDIA_TYPE_BY_FORMAT,
  type XrAssetDigest,
  type XrAssetFormat,
} from "../assets/contracts";
import { xrAssetHttpPath } from "../assets/http";
import {
  parseXrAssetDigest,
  parseXrAssetFormat,
} from "../assets/validation";
import { digestBlobSha256 } from "../../workspace/assets/digest";
import {
  parseXrOpaqueId,
  parseXrWorkspaceId,
  type XrAckMessage,
  type XrErrorMessage,
  type XrRoutableMessage,
} from "../protocol";
import {
  XrNetworkError,
  type XrHttpTransportBaseOptions,
} from "./contracts";
import { XrHttpJsonClient } from "./httpClient";
import { XR_HTTP_PATHS } from "./paths";
import {
  authorityConnectionView,
  parseAssetPutResult,
  parseAuthorityConnection,
  parseAuthorityOutgoing,
  parseAuthorityPoll,
  parseDisconnect,
  parsePairingGrant,
  parseRevocation,
  parseSendResponse,
  strictResponse,
  type XrParsedConnection,
  type XrParsedAssetPutResult,
} from "./validation";

// Match the relay cache's default policy so transport-valid input does not
// depend on a host opting into a larger server-side TTL.
const MAXIMUM_ASSET_TTL_MS = 24 * 60 * 60_000;
// Authority projection messages are relay-idempotent by the exact requestId
// and envelope. Replay once to close the "relay committed, HTTP ACK was lost"
// window without creating an unbounded retry loop.
const MAXIMUM_AUTHORITY_SEND_ATTEMPTS = 2;
const MAXIMUM_AUTHORITY_CONNECT_ATTEMPTS = 2;
const MAXIMUM_PAIRING_REVOKE_ATTEMPTS = 2;

function connectRequestId(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new XrNetworkError(
      "crypto_unavailable",
      "Secure randomness is required for the XR authority connection.",
      false,
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `xr-authority-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function isAmbiguousConnectFailure(cause: unknown): cause is XrNetworkError {
  return cause instanceof XrNetworkError
    && (cause.retryable
      // A connect response can be committed before its JSON body, media type,
      // or envelope is truncated/corrupted. Exact request replay is safe and
      // closes that ambiguity without retrying explicit HTTP rejections.
      || (cause.status === undefined
        && (cause.code === "invalid_response" || cause.code === "response_too_large")));
}

export type XrAuthorityAssetPutResult = XrParsedAssetPutResult;

function invalidLocalRequest(): XrNetworkError {
  return new XrNetworkError("invalid_request", "The XR request is invalid.", false);
}

function strictLocal<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof XrNetworkError) throw error;
    throw invalidLocalRequest();
  }
}

/** Browser Fetch transport for the one canonical Workspace authority. */
export class XrAuthorityHttpTransport implements XrAuthorityTransport {
  readonly #client: XrHttpJsonClient;
  #connection?: XrParsedConnection;
  #connecting = false;

  constructor(options: XrHttpTransportBaseOptions) {
    this.#client = new XrHttpJsonClient(options);
  }

  async connect(workspaceIdValue: string): Promise<XrAuthorityConnectionView> {
    if (this.#connection || this.#connecting) {
      throw new XrNetworkError("already_connected", "The XR authority is already connected.", false);
    }
    const workspaceId = strictLocal(() => parseXrWorkspaceId(workspaceIdValue, "$.workspaceId"));
    const requestId = strictLocal(() => parseXrOpaqueId(connectRequestId(), "$.requestId"));
    const body = Object.freeze({ workspaceId, requestId });
    this.#connecting = true;
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const value = await this.#client.post(XR_HTTP_PATHS.authorityConnect, body);
          const connection = strictResponse(() => parseAuthorityConnection(value));
          if (connection.identity.workspaceId !== workspaceId) {
            throw new XrNetworkError(
              "workspace_mismatch",
              "The XR relay connected to another Workspace.",
              false,
            );
          }
          this.#connection = connection;
          return authorityConnectionView(connection);
        } catch (cause) {
          if (!isAmbiguousConnectFailure(cause)
            || attempt >= MAXIMUM_AUTHORITY_CONNECT_ATTEMPTS) {
            throw cause;
          }
        }
      }
    } finally {
      this.#connecting = false;
    }
  }

  async send(messageValue: XrRoutableMessage): Promise<XrAckMessage | XrErrorMessage> {
    const connection = this.#requireConnection();
    const message = strictLocal(() => parseAuthorityOutgoing(messageValue, connection.identity));
    const body = Object.freeze({ message });
    let value: unknown;
    for (let attempt = 1; ; attempt += 1) {
      try {
        value = await this.#client.post(
          XR_HTTP_PATHS.sessionSend,
          body,
          connection.credential,
        );
        break;
      } catch (cause) {
        if (!(cause instanceof XrNetworkError)
          || !cause.retryable
          || attempt >= MAXIMUM_AUTHORITY_SEND_ATTEMPTS) {
          throw cause;
        }
      }
    }
    return strictResponse(() => parseSendResponse(value, connection.identity));
  }

  async poll(acknowledgedDeliveryIds: readonly string[] = []): Promise<readonly XrAuthorityPollDelivery[]> {
    const connection = this.#requireConnection();
    if (acknowledgedDeliveryIds.length > 512) throw invalidLocalRequest();
    const acknowledgements = acknowledgedDeliveryIds.map((value, index) => (
      strictLocal(() => parseXrOpaqueId(value, `$.acknowledgedDeliveryIds[${index}]`))
    ));
    if (new Set(acknowledgements).size !== acknowledgements.length) throw invalidLocalRequest();
    const value = await this.#client.post(
      XR_HTTP_PATHS.sessionPoll,
      { acknowledgedDeliveryIds: acknowledgements },
      connection.credential,
    );
    return strictResponse(() => parseAuthorityPoll(value, connection.identity));
  }

  async createPairing(
    ttlMs?: number,
    capabilities: Readonly<{ voiceRelay?: boolean }> = {},
  ): Promise<XrAuthorityPairingGrant> {
    const connection = this.#requireConnection();
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000)) {
      throw invalidLocalRequest();
    }
    if (capabilities.voiceRelay !== undefined && typeof capabilities.voiceRelay !== "boolean") {
      throw invalidLocalRequest();
    }
    const value = await this.#client.post(
      XR_HTTP_PATHS.authorityPairings,
      {
        ...(ttlMs === undefined ? {} : { ttlMs }),
        ...(capabilities.voiceRelay === undefined ? {} : { voiceRelay: capabilities.voiceRelay }),
      },
      connection.credential,
    );
    // The grant, including its one-shot token, is returned directly and is
    // never retained by this transport.
    return strictResponse(() => parsePairingGrant(value, connection.identity));
  }

  async revokePairing(pairingIdValue: string): Promise<boolean> {
    const connection = this.#requireConnection();
    const pairingId = strictLocal(() => parseXrOpaqueId(pairingIdValue, "$.pairingId"));
    for (let attempt = 1; ; attempt += 1) {
      try {
        const value = await this.#client.post(
          XR_HTTP_PATHS.authorityPairingsRevoke,
          { pairingId },
          connection.credential,
        );
        return strictResponse(() => parseRevocation(value));
      } catch (cause) {
        const ambiguous = cause instanceof XrNetworkError
          && (cause.retryable
            || (cause.status === undefined
              && (cause.code === "invalid_response" || cause.code === "response_too_large")));
        if (!ambiguous || attempt >= MAXIMUM_PAIRING_REVOKE_ATTEMPTS) throw cause;
      }
    }
  }

  /**
   * Publishes immutable asset bytes using the authority credential retained by
   * this transport. The bearer never crosses the caller-facing API.
   */
  async putAsset(
    blob: Blob,
    digestValue: XrAssetDigest,
    formatValue: XrAssetFormat,
    ttlMsValue: number,
    signal?: AbortSignal,
  ): Promise<XrAuthorityAssetPutResult> {
    const connection = this.#requireConnection();
    if (!(blob instanceof Blob)
      || blob.size < 1
      || blob.size > XR_ASSET_LIMITS.maximumAssetBytes
      || !Number.isSafeInteger(ttlMsValue)
      || ttlMsValue < 1
      || ttlMsValue > MAXIMUM_ASSET_TTL_MS) {
      throw invalidLocalRequest();
    }
    const digest = strictLocal(() => parseXrAssetDigest(digestValue));
    const format = strictLocal(() => parseXrAssetFormat(formatValue));
    let actualDigest: string;
    try {
      actualDigest = await digestBlobSha256(blob, {
        signal,
        maximumBytes: XR_ASSET_LIMITS.maximumAssetBytes,
      });
    } catch {
      if (signal?.aborted) {
        throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
      }
      throw invalidLocalRequest();
    }
    if (actualDigest !== digest) {
      throw new XrNetworkError("digest_mismatch", "The XR asset digest does not match its bytes.", false);
    }
    const value = await this.#client.putAsset(
      blob,
      {
        digest,
        format,
        mediaType: XR_ASSET_MEDIA_TYPE_BY_FORMAT[format],
        ttlMs: ttlMsValue,
      },
      connection.credential,
      signal,
    );
    return strictResponse(() => parseAssetPutResult(value, {
      digest,
      format,
      byteLength: blob.size,
    }));
  }

  /** Checks current relay residency using the private authority credential. */
  async hasAsset(
    digestValue: XrAssetDigest,
    formatValue: XrAssetFormat,
    byteLengthValue: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const connection = this.#requireConnection();
    if (!Number.isSafeInteger(byteLengthValue)
      || byteLengthValue < 1
      || byteLengthValue > XR_ASSET_LIMITS.maximumAssetBytes) {
      throw invalidLocalRequest();
    }
    const digest = strictLocal(() => parseXrAssetDigest(digestValue));
    const format = strictLocal(() => parseXrAssetFormat(formatValue));
    return this.#client.headAsset(
      xrAssetHttpPath(digest),
      {
        digest,
        format,
        mediaType: XR_ASSET_MEDIA_TYPE_BY_FORMAT[format],
        byteLength: byteLengthValue,
      },
      connection.credential,
      signal,
    );
  }

  async disconnect(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (!connection) return;
    const value = await this.#client.post(
      XR_HTTP_PATHS.sessionDisconnect,
      {},
      connection.credential,
    );
    strictResponse(() => parseDisconnect(value));
  }

  #requireConnection(): XrParsedConnection {
    if (!this.#connection) {
      throw new XrNetworkError("not_connected", "The XR authority is not connected.", false);
    }
    return this.#connection;
  }
}
