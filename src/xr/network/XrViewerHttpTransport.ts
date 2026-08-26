import type {
  XrViewerDisconnect,
  XrViewerIncomingMessage,
  XrViewerPairRequest,
  XrViewerReconnectDelivery,
  XrViewerReconnectOptions,
  XrViewerSessionIdentity,
  XrViewerTransportPort,
  XrViewerTransportSession,
} from "../app/contracts";
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
  createWindowsUltraLocalEvidencePort,
  isLikelyWindowsX64Browser,
  type UltraLocalEvidencePort,
} from "../ultra";
import {
  XR_RELAY_PROTOCOL_VERSION,
  XR_SESSION_PRESENCE_CHANNEL,
  parseXrRevision,
  parseXrViewerPresence,
  type XrEphemeralMessage,
  parseXrOpaqueId,
  type XrInputMessage,
  type XrReconnectCursor,
  type XrRoutableMessage,
  type XrViewerPresencePhase,
} from "../protocol";
import {
  XrNetworkError,
  type XrNetworkTimerHandle,
  type XrViewerHttpTransportOptions,
} from "./contracts";
import { VOICE_RELAY_HTTP_PATHS, VoiceRelayHttpClient } from "../../voice-relay";
import { XrHttpJsonClient } from "./httpClient";
import { XR_HTTP_PATHS } from "./paths";
import { XR_HTTP_SESSION_HEADER } from "./paths";
import {
  parseDisconnect,
  parseReconnectCursorForIdentity,
  parseReconnectDelivery,
  parseSendResponse,
  parseViewerConnection,
  parseViewerOutgoing,
  parseViewerPoll,
  strictResponse,
  type XrParsedConnection,
  type XrPrivateCredential,
  type XrReconnectDelivery,
  type XrPollDelivery,
} from "./validation";
import {
  parseUltraRuntimeSampleResponse,
  parseUltraStaticProbeResponse,
} from "./ultraEvidence";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PAIRING_CODE_PATTERN = /^[0-9]{6}$/u;
const EMPTY_DIGEST = `sha256:${"0".repeat(64)}` as const;
// A viewer input is idempotent by its exact request envelope at the relay.
// One bounded replay closes the common "committed request, lost HTTP ACK"
// window without turning a broken connection into an unbounded send loop.
const MAXIMUM_VIEWER_INPUT_SEND_ATTEMPTS = 2;

type SessionState = "preparing" | "active" | "disconnected" | "closed";

function checkedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `xr-viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function asNetworkError(error: unknown): XrNetworkError {
  return error instanceof XrNetworkError
    ? error
    : new XrNetworkError("operation_failed", "The XR operation failed.", false);
}

function combinedSignal(signals: readonly (AbortSignal | undefined)[]): Readonly<{
  signal: AbortSignal;
  cleanup(): void;
}> {
  const controller = new AbortController();
  const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const listener = () => controller.abort();
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
    },
  });
}

function strictLocal<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof XrNetworkError) throw error;
    throw new XrNetworkError("invalid_request", "The XR request is invalid.", false);
  }
}

function initialCursor(
  identity: XrViewerSessionIdentity,
  nextRequestId: () => string,
): XrReconnectCursor {
  const generated = strictLocal(() => parseXrOpaqueId(nextRequestId(), "$.requestId"));
  return Object.freeze({
    protocolVersion: XR_RELAY_PROTOCOL_VERSION,
    ...identity,
    revision: Number.MAX_SAFE_INTEGER,
    snapshotDigest: EMPTY_DIGEST,
    requestId: generated,
  });
}

export interface XrViewerHttpTransportSession extends XrViewerTransportSession {
  openAsset(
    digest: XrAssetDigest,
    format: XrAssetFormat,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<Blob>;
}

class HttpViewerSession implements XrViewerHttpTransportSession {
  readonly identity: XrViewerSessionIdentity;
  readonly ultraEvidence?: UltraLocalEvidencePort;
  readonly voiceRelay?: VoiceRelayHttpClient;
  readonly #client: XrHttpJsonClient;
  readonly #onMessage: (message: XrViewerIncomingMessage) => unknown | Promise<unknown>;
  readonly #onReconnectDelivery: ((delivery: XrViewerReconnectDelivery) => unknown | Promise<unknown>) | undefined;
  readonly #onDisconnected: (event: XrViewerDisconnect) => void;
  readonly #release: (session: HttpViewerSession) => void;
  readonly #nextRequestId: () => string;
  readonly #pollIntervalMs: number;
  readonly #pollBackoffBaseMs: number;
  readonly #pollBackoffMaximumMs: number;
  readonly #maximumPollFailures: number;
  readonly #lifecycleAbort = new AbortController();
  #credential?: XrPrivateCredential;
  #state: SessionState = "preparing";
  #pendingReconnect?: XrReconnectDelivery;
  #pollStartTimer?: XrNetworkTimerHandle;
  #pollAbort?: AbortController;
  #presenceSequence = 0;
  #presenceQueue: Promise<void> = Promise.resolve();
  #presenceTail?: Readonly<{
    phase: XrViewerPresencePhase;
    revision: number;
    signal: AbortSignal | undefined;
    operation: Promise<void>;
  }>;
  readonly #acknowledgedDeliveryIds = new Set<string>();

  constructor(input: Readonly<{
    client: XrHttpJsonClient;
    connection: XrParsedConnection;
    onMessage(message: XrViewerIncomingMessage): unknown | Promise<unknown>;
    onReconnectDelivery?(delivery: XrViewerReconnectDelivery): unknown | Promise<unknown>;
    onDisconnected(event: XrViewerDisconnect): void;
    release(session: HttpViewerSession): void;
    nextRequestId(): string;
    pollIntervalMs: number;
    pollBackoffBaseMs: number;
    pollBackoffMaximumMs: number;
    maximumPollFailures: number;
    voiceRelayBaseUrl: string;
    voiceRelayFetch?: typeof fetch;
  }>) {
    this.#client = input.client;
    this.identity = input.connection.identity;
    this.#credential = input.connection.credential;
    this.#onMessage = input.onMessage;
    this.#onReconnectDelivery = input.onReconnectDelivery;
    this.#onDisconnected = input.onDisconnected;
    this.#release = input.release;
    this.#nextRequestId = input.nextRequestId;
    this.#pollIntervalMs = input.pollIntervalMs;
    this.#pollBackoffBaseMs = input.pollBackoffBaseMs;
    this.#pollBackoffMaximumMs = input.pollBackoffMaximumMs;
    this.#maximumPollFailures = input.maximumPollFailures;
    if (input.connection.voiceRelayAllowed) {
      this.voiceRelay = new VoiceRelayHttpClient({
        baseUrl: input.voiceRelayBaseUrl,
        ...(input.voiceRelayFetch ? { fetchImpl: input.voiceRelayFetch } : {}),
        requestHeaders: () => {
          const credential = this.#requireCredential();
          return {
            authorization: `Bearer ${credential.sessionBearer}`,
            [XR_HTTP_SESSION_HEADER]: credential.sessionId,
          };
        },
      });
    }
    if (typeof navigator !== "undefined" && isLikelyWindowsX64Browser(navigator)) {
      this.ultraEvidence = createWindowsUltraLocalEvidencePort({
        system: {
          collectStaticProbe: async (browser, signal) => {
            const value = await this.#client.post(
              XR_HTTP_PATHS.rendererUltraProbe,
              { browser },
              this.#requireCredential(),
              signal,
            );
            return strictResponse(() => parseUltraStaticProbeResponse(value));
          },
          sampleRuntime: async (signal) => {
            const value = await this.#client.post(
              XR_HTTP_PATHS.rendererUltraSample,
              {},
              this.#requireCredential(),
              signal,
            );
            return strictResponse(() => parseUltraRuntimeSampleResponse(value));
          },
        },
      });
    }
  }

  async prepare(signal: AbortSignal): Promise<void> {
    const cursor = initialCursor(this.identity, this.#nextRequestId);
    this.#pendingReconnect = await this.#requestReconnect(cursor, signal);
  }

  activateAfterPair(): void {
    if (this.#state !== "preparing") return;
    this.#state = "active";
    // A task boundary guarantees pair() has resolved and the app has created
    // its projection replica before the first callback.
    this.#pollStartTimer = this.#client.setTimer(() => {
      this.#pollStartTimer = undefined;
      if (this.#state !== "active") return;
      void (async () => {
        try {
          const pending = this.#pendingReconnect;
          this.#pendingReconnect = undefined;
          if (pending) await this.#deliverReconnect(pending, this.#onReconnectDelivery);
          this.#startPolling();
        } catch (error) {
          this.#transitionFromPollFailure(asNetworkError(error));
        }
      })();
    }, 0);
  }

  async send(
    messageValue: XrInputMessage,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<void> {
    if (this.#state !== "active") {
      throw new XrNetworkError("not_connected", "The XR viewer is not connected.", false);
    }
    const message = strictLocal(() => parseViewerOutgoing(messageValue, this.identity));
    await this.#sendRoutable(message, options);
  }

  async publishPresence(
    phaseValue: XrViewerPresencePhase,
    revisionValue: number,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<void> {
    const phase = strictLocal(() => parseXrViewerPresence({ phase: phaseValue }).phase);
    const revision = strictLocal(() => parseXrRevision(revisionValue, "$.revision"));
    const tail = this.#presenceTail;
    if (tail?.phase === phase && tail.revision === revision && tail.signal === options.signal) {
      await tail.operation;
      return;
    }
    const operation = this.#presenceQueue.then(async () => {
      if (this.#state !== "active") {
        throw new XrNetworkError("not_connected", "The XR viewer is not connected.", false);
      }
      const sequence = this.#presenceSequence + 1;
      // Never reuse a sequence after an ambiguous HTTP result. Gaps are legal;
      // reusing a possibly committed sequence with a new request id is not.
      this.#presenceSequence = sequence;
      const message: XrEphemeralMessage = Object.freeze({
        protocolVersion: XR_RELAY_PROTOCOL_VERSION,
        messageType: "ephemeral",
        ...this.identity,
        revision,
        requestId: strictLocal(() => parseXrOpaqueId(this.#nextRequestId(), "$.requestId")),
        channel: XR_SESSION_PRESENCE_CHANNEL,
        sequence,
        payload: Object.freeze({ phase }),
      });
      await this.#sendRoutable(message, options);
    });
    this.#presenceQueue = operation.catch(() => undefined);
    const tracked = operation.finally(() => {
      if (this.#presenceTail?.operation === tracked) this.#presenceTail = undefined;
    });
    this.#presenceTail = Object.freeze({ phase, revision, signal: options.signal, operation: tracked });
    await tracked;
  }

  async #sendRoutable(
    message: XrRoutableMessage,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<void> {
    const credential = this.#requireCredential();
    const body = Object.freeze({ message });
    const linked = combinedSignal([this.#lifecycleAbort.signal, options.signal]);
    try {
      let value: unknown;
      for (let attempt = 1; ; attempt += 1) {
        try {
          value = await this.#client.post(
            XR_HTTP_PATHS.sessionSend,
            body,
            credential,
            linked.signal,
          );
          break;
        } catch (cause) {
          const error = asNetworkError(cause);
          if (!error.retryable
            || linked.signal.aborted
            || attempt >= MAXIMUM_VIEWER_INPUT_SEND_ATTEMPTS) {
            throw error;
          }
        }
      }
      const response = strictResponse(() => parseSendResponse(value, this.identity));
      if (response.messageType === "error") {
        throw new XrNetworkError(
          response.code,
          "The XR relay rejected viewer input.",
          response.retryable,
        );
      }
    } finally {
      linked.cleanup();
    }
  }

  async reconnect(
    cursorValue: XrReconnectCursor | undefined,
    options: XrViewerReconnectOptions = {},
  ): Promise<void> {
    if (this.#state === "closed") {
      throw new XrNetworkError("not_connected", "The XR viewer session is closed.", false);
    }
    this.#stopPolling();
    const cursor = cursorValue === undefined
      ? initialCursor(this.identity, this.#nextRequestId)
      : strictLocal(() => parseReconnectCursorForIdentity(cursorValue, this.identity));
    const linked = combinedSignal([this.#lifecycleAbort.signal, options.signal]);
    this.#state = "disconnected";
    try {
      const delivery = await this.#requestReconnect(cursor, linked.signal);
      if (linked.signal.aborted || this.#lifecycleAbort.signal.aborted) {
        throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
      }
      await this.#deliverReconnect(delivery, options.applyDelivery ?? this.#onReconnectDelivery);
      this.#state = "active";
      this.#startPolling();
    } catch (cause) {
      const error = asNetworkError(cause);
      if (!this.#lifecycleAbort.signal.aborted && error.code !== "aborted") {
        this.#transitionFromPollFailure(error);
      }
      throw error;
    } finally {
      linked.cleanup();
    }
  }

  async openAsset(
    digestValue: XrAssetDigest,
    formatValue: XrAssetFormat,
    byteLengthValue: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    if (this.#state !== "active") {
      throw new XrNetworkError("not_connected", "The XR viewer is not connected.", false);
    }
    const digest = strictLocal(() => parseXrAssetDigest(digestValue));
    const format = strictLocal(() => parseXrAssetFormat(formatValue));
    if (!Number.isSafeInteger(byteLengthValue)
      || byteLengthValue < 1
      || byteLengthValue > XR_ASSET_LIMITS.maximumAssetBytes) {
      throw new XrNetworkError("invalid_request", "The XR asset request is invalid.", false);
    }
    const linked = combinedSignal([this.#lifecycleAbort.signal, signal]);
    try {
      const blob = await this.#client.getAsset(
        xrAssetHttpPath(digest),
        {
          digest,
          format,
          mediaType: XR_ASSET_MEDIA_TYPE_BY_FORMAT[format],
          byteLength: byteLengthValue,
        },
        this.#requireCredential(),
        linked.signal,
      );
      let actualDigest: string;
      try {
        actualDigest = await digestBlobSha256(blob, {
          signal: linked.signal,
          maximumBytes: XR_ASSET_LIMITS.maximumAssetBytes,
        });
      } catch {
        if (linked.signal.aborted) {
          throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
        }
        throw new XrNetworkError("invalid_response", "The XR relay returned invalid asset bytes.", false);
      }
      if (actualDigest !== digest) {
        throw new XrNetworkError("digest_mismatch", "The XR relay returned invalid asset bytes.", false);
      }
      return blob;
    } finally {
      linked.cleanup();
    }
  }

  async close(_reason?: string): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#stopPolling();
    this.#lifecycleAbort.abort();
    this.#pendingReconnect = undefined;
    this.#acknowledgedDeliveryIds.clear();
    const credential = this.#credential;
    this.#credential = undefined;
    this.#release(this);
    if (!credential) return;
    try {
      const value = await this.#client.post(
        XR_HTTP_PATHS.sessionDisconnect,
        {},
        credential,
      );
      strictResponse(() => parseDisconnect(value));
    } catch {
      // close() is best effort and must not create an unhandled rejection on unmount.
    }
  }

  async #requestReconnect(
    cursor: XrReconnectCursor,
    signal: AbortSignal,
  ): Promise<XrReconnectDelivery> {
    const value = await this.#client.post(
      XR_HTTP_PATHS.rendererReconnect,
      { cursor },
      this.#requireCredential(),
      signal,
    );
    return strictResponse(() => parseReconnectDelivery(value, this.identity, cursor));
  }

  #startPolling(): void {
    if (this.#state !== "active" || this.#pollAbort) return;
    const controller = new AbortController();
    this.#pollAbort = controller;
    void this.#pollLoop(controller).finally(() => {
      if (this.#pollAbort === controller) this.#pollAbort = undefined;
    });
  }

  async #pollLoop(controller: AbortController): Promise<void> {
    let failures = 0;
    while (this.#state === "active" && !controller.signal.aborted) {
      try {
        const acknowledgements = Object.freeze([...this.#acknowledgedDeliveryIds]);
        const value = await this.#client.post(
          XR_HTTP_PATHS.sessionPoll,
          { acknowledgedDeliveryIds: acknowledgements },
          this.#requireCredential(),
          controller.signal,
        );
        const deliveries = strictResponse(() => parseViewerPoll(value, this.identity));
        if (controller.signal.aborted || this.#state !== "active") return;
        for (const deliveryId of acknowledgements) this.#acknowledgedDeliveryIds.delete(deliveryId);
        await this.#deliverDeliveries(deliveries);
        failures = 0;
        await this.#client.delay(this.#pollIntervalMs, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted || this.#state !== "active") return;
        const error = asNetworkError(cause);
        failures += 1;
        if (!error.retryable || failures >= this.#maximumPollFailures) {
          this.#transitionFromPollFailure(error);
          return;
        }
        const delay = Math.min(
          this.#pollBackoffMaximumMs,
          this.#pollBackoffBaseMs * (2 ** (failures - 1)),
        );
        try {
          await this.#client.delay(delay, controller.signal);
        } catch {
          return;
        }
      }
    }
  }

  async #deliverMessages(messages: readonly XrViewerIncomingMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.#onMessage(message);
      } catch {
        throw new XrNetworkError(
          "callback_failed",
          "The XR viewer could not apply a relay message.",
          true,
        );
      }
    }
  }

  async #deliverReconnect(
    delivery: XrViewerReconnectDelivery,
    applyDelivery: ((delivery: XrViewerReconnectDelivery) => unknown | Promise<unknown>) | undefined,
  ): Promise<void> {
    if (!applyDelivery) {
      await this.#deliverMessages(delivery.messages);
      return;
    }
    try {
      await applyDelivery(delivery);
    } catch {
      throw new XrNetworkError(
        "callback_failed",
        "The XR viewer could not apply a reconnect checkpoint.",
        true,
      );
    }
  }

  async #deliverDeliveries(
    deliveries: readonly XrPollDelivery<XrViewerIncomingMessage>[],
  ): Promise<void> {
    for (const delivery of deliveries) {
      await this.#deliverMessages([delivery.message]);
      this.#acknowledgedDeliveryIds.add(delivery.deliveryId);
    }
  }

  #transitionFromPollFailure(error: XrNetworkError): void {
    if (this.#state === "closed") return;
    const retryable = error.retryable;
    const credentialToRelease = retryable ? undefined : this.#credential;
    this.#state = retryable ? "disconnected" : "closed";
    this.#stopPolling();
    if (!retryable) {
      this.#credential = undefined;
      this.#lifecycleAbort.abort();
      this.#release(this);
      if (credentialToRelease) {
        // A terminal parser/callback/auth failure must not strand a renderer
        // slot in the relay after this object deliberately forgets its bearer.
        // The request is best effort and credential-scoped; the local closed
        // transition never waits on network cleanup.
        void this.#client.post(
          XR_HTTP_PATHS.sessionDisconnect,
          {},
          credentialToRelease,
        ).then((value) => strictResponse(() => parseDisconnect(value))).catch(() => undefined);
      }
    }
    try {
      this.#onDisconnected(Object.freeze({ reason: error.message, retryable }));
    } catch {
      // Consumer callbacks cannot escape the background polling task.
    }
  }

  #stopPolling(): void {
    if (this.#pollStartTimer !== undefined) {
      this.#client.clearTimer(this.#pollStartTimer);
      this.#pollStartTimer = undefined;
    }
    this.#pollAbort?.abort();
    this.#pollAbort = undefined;
  }

  #requireCredential(): XrPrivateCredential {
    if (!this.#credential) {
      throw new XrNetworkError("not_connected", "The XR viewer is not connected.", false);
    }
    return this.#credential;
  }
}

/** Browser Fetch transport for a renderer-only XR viewer. */
export class XrViewerHttpTransport implements XrViewerTransportPort {
  readonly #client: XrHttpJsonClient;
  readonly #voiceRelayBaseUrl: string;
  readonly #voiceRelayFetch?: typeof fetch;
  readonly #nextRequestId: () => string;
  readonly #pollIntervalMs: number;
  readonly #pollBackoffBaseMs: number;
  readonly #pollBackoffMaximumMs: number;
  readonly #maximumPollFailures: number;
  #active?: HttpViewerSession;
  #pairing = false;

  constructor(options: XrViewerHttpTransportOptions) {
    this.#client = new XrHttpJsonClient(options);
    this.#voiceRelayBaseUrl = `${new URL(options.baseUrl.toString()).origin}${VOICE_RELAY_HTTP_PATHS.xrBase}`;
    this.#voiceRelayFetch = options.fetch;
    this.#nextRequestId = options.requestId ?? requestId;
    this.#pollIntervalMs = checkedInteger(options.pollIntervalMs, 100, 1, 60_000, "pollIntervalMs");
    this.#pollBackoffBaseMs = checkedInteger(
      options.pollBackoffBaseMs,
      250,
      1,
      60_000,
      "pollBackoffBaseMs",
    );
    this.#pollBackoffMaximumMs = checkedInteger(
      options.pollBackoffMaximumMs,
      5_000,
      this.#pollBackoffBaseMs,
      120_000,
      "pollBackoffMaximumMs",
    );
    this.#maximumPollFailures = checkedInteger(
      options.maximumPollFailures,
      3,
      1,
      10,
      "maximumPollFailures",
    );
  }

  pair(request: XrViewerPairRequest): Promise<XrViewerHttpTransportSession> {
    if (this.#active || this.#pairing) {
      return Promise.reject(new XrNetworkError(
        "already_connected",
        "An XR viewer session is already active.",
        false,
      ));
    }
    const hasPairingToken = Object.prototype.hasOwnProperty.call(request, "pairingToken");
    const hasPairingCode = Object.prototype.hasOwnProperty.call(request, "pairingCode");
    const credential = hasPairingToken === hasPairingCode
      ? undefined
      : hasPairingToken && typeof request.pairingToken === "string"
        ? Object.freeze({ key: "pairingToken" as const, value: request.pairingToken })
        : hasPairingCode && typeof request.pairingCode === "string"
          ? Object.freeze({ key: "pairingCode" as const, value: request.pairingCode })
          : undefined;
    const credentialIsValid = credential !== undefined && (credential.key === "pairingToken"
      ? CAPABILITY_PATTERN.test(credential.value)
      : PAIRING_CODE_PATTERN.test(credential.value));
    if (typeof request.onMessage !== "function"
      || typeof request.onDisconnected !== "function"
      || !credential
      || !credentialIsValid) {
      return Promise.reject(new XrNetworkError(
        "pairing_invalid",
        "XR pairing failed.",
        false,
      ));
    }
    this.#pairing = true;
    return this.#pairOnce(
      credential,
      request.signal,
      request.onMessage,
      request.onReconnectDelivery,
      request.onDisconnected,
    ).finally(() => {
      this.#pairing = false;
    });
  }

  async #pairOnce(
    credentialValue: Readonly<{
      key: "pairingToken" | "pairingCode";
      value: string;
    }>,
    signal: AbortSignal,
    onMessage: (message: XrViewerIncomingMessage) => unknown | Promise<unknown>,
    onReconnectDelivery: ((delivery: XrViewerReconnectDelivery) => unknown | Promise<unknown>) | undefined,
    onDisconnected: (event: XrViewerDisconnect) => void,
  ): Promise<XrViewerHttpTransportSession> {
    let credential = credentialValue.value;
    let connection: XrParsedConnection;
    try {
      const value = await this.#client.post(
        XR_HTTP_PATHS.rendererConnect,
        { [credentialValue.key]: credential },
        undefined,
        signal,
      );
      connection = strictResponse(() => parseViewerConnection(value));
    } finally {
      credential = "";
      credentialValue = { key: credentialValue.key, value: "" };
    }
    const session = new HttpViewerSession({
      client: this.#client,
      connection,
      onMessage,
      onReconnectDelivery,
      onDisconnected,
      release: (candidate) => {
        if (this.#active === candidate) this.#active = undefined;
      },
      nextRequestId: this.#nextRequestId,
      pollIntervalMs: this.#pollIntervalMs,
      pollBackoffBaseMs: this.#pollBackoffBaseMs,
      pollBackoffMaximumMs: this.#pollBackoffMaximumMs,
      maximumPollFailures: this.#maximumPollFailures,
      voiceRelayBaseUrl: this.#voiceRelayBaseUrl,
      ...(this.#voiceRelayFetch ? { voiceRelayFetch: this.#voiceRelayFetch } : {}),
    });
    try {
      await session.prepare(signal);
      if (signal.aborted) throw new XrNetworkError("aborted", "The XR request was cancelled.", false);
      this.#active = session;
      session.activateAfterPair();
      return session;
    } catch (error) {
      await session.close("pairing_failed");
      throw asNetworkError(error);
    }
  }
}
