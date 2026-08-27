import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  SEMAFRAME_EXCHANGE_PATHS,
  SEMAFRAME_EXCHANGE_FORMAT,
  SEMAFRAME_EXCHANGE_LIMITS,
  SEMAFRAME_EXCHANGE_VERSION,
  assertSafeExchangePath,
  bridgeJsonBytes,
  parseSemaFrameBridgeChangeProposal,
  type SemaFrameBridgeChangeProposal,
  type SemaFrameBridgeTarget,
  type SemaFrameExchangeManifest,
  type SemaFrameSha256,
} from "../../src/bridge";

export const BRIDGE_SESSION_LIMITS = Object.freeze({
  defaultTtlMs: 30 * 60_000,
  maximumTtlMs: 8 * 60 * 60_000,
  maximumArchiveBytes: 512 * 1024 * 1024,
  maximumPendingProposals: 100,
  maximumSessions: 32,
});

export type BridgePublication = Readonly<{
  sequence: number;
  workspaceId: string;
  revision: number;
  exchangeDigest: SemaFrameSha256;
  manifest: SemaFrameExchangeManifest;
  archive: Uint8Array;
}>;

export type BridgeSessionAccess = Readonly<{
  sessionId: string;
  bearer: string;
  target: SemaFrameBridgeTarget;
  expiresAt: string;
}>;

export type BridgeSessionView = Readonly<{
  sessionId: string;
  target: SemaFrameBridgeTarget;
  expiresAt: string;
  publication: Readonly<{
    sequence: number;
    workspaceId: string;
    revision: number;
    exchangeDigest: SemaFrameSha256;
    manifest: SemaFrameExchangeManifest;
    byteLength: number;
  }>;
}>;

export type BridgeProposalRecord = Readonly<{
  cursor: number;
  receivedAt: string;
  proposal: SemaFrameBridgeChangeProposal;
}>;

type MutableSession = {
  sessionId: string;
  ownerId: string;
  target: SemaFrameBridgeTarget;
  tokenHash: Buffer;
  expiresAtMs: number;
  publication: BridgePublication;
  proposalCursor: number;
  proposals: BridgeProposalRecord[];
};

export class BridgeSessionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "session_expired"
      | "unauthorized"
      | "invalid_publication"
      | "invalid_proposal"
      | "stale_publication"
      | "proposal_mismatch"
      | "capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "BridgeSessionError";
  }
}

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(value: string, expected: Buffer): boolean {
  const actual = tokenHash(value);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function copyPublication(value: BridgePublication): BridgePublication {
  const archive = new Uint8Array(value.archive.byteLength);
  archive.set(value.archive);
  return Object.freeze({
    sequence: value.sequence,
    workspaceId: value.workspaceId,
    revision: value.revision,
    exchangeDigest: value.exchangeDigest,
    manifest: structuredClone(value.manifest),
    archive,
  });
}

function publicationDigest(archive: Uint8Array): SemaFrameSha256 {
  return `sha256:${createHash("sha256").update(archive).digest("hex")}`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readExchangeEntries(archive: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map<string, Uint8Array>();
  const directoryEntries: {
    path: string;
    name: Uint8Array;
    checksum: number;
    byteLength: number;
    localOffset: number;
  }[] = [];
  let offset = 0;
  while (offset + 4 <= archive.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    if (entries.size >= 16 || offset + 30 > archive.byteLength) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP structure is invalid");
    }
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const byteLength = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (view.getUint16(offset + 4, true) !== 20 || flags !== 0x0800 || method !== 0
      || view.getUint16(offset + 10, true) !== 0 || view.getUint16(offset + 12, true) !== 33
      || compressedSize !== byteLength || nameLength < 1 || nameLength > 256 || extraLength !== 0) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP entries must be deterministic stored UTF-8 files");
    }
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const dataEnd = nameEnd + byteLength;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > archive.byteLength) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP entry is truncated");
    }
    let path: string;
    try {
      path = decoder.decode(archive.slice(nameStart, nameEnd));
      assertSafeExchangePath(path);
    } catch {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP entry path is invalid");
    }
    if (entries.has(path)) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP contains duplicate entries");
    }
    const bytes = archive.slice(nameEnd, dataEnd);
    if (crc32(bytes) !== checksum) {
      throw new BridgeSessionError("invalid_publication", `Bridge exchange file ${path} failed CRC verification`);
    }
    entries.set(path, bytes);
    directoryEntries.push({
      path,
      name: archive.slice(nameStart, nameEnd),
      checksum,
      byteLength,
      localOffset: offset,
    });
    offset = dataEnd;
  }
  if (entries.size < 1 || offset + 4 > archive.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP central directory is missing");
  }
  const centralOffset = offset;
  for (const local of directoryEntries) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP central directory is invalid");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const recordEnd = nameEnd + extraLength + commentLength;
    if (recordEnd > archive.byteLength
      || view.getUint16(offset + 4, true) !== 20
      || view.getUint16(offset + 6, true) !== 20
      || view.getUint16(offset + 8, true) !== 0x0800
      || view.getUint16(offset + 10, true) !== 0
      || view.getUint16(offset + 12, true) !== 0
      || view.getUint16(offset + 14, true) !== 33
      || view.getUint32(offset + 16, true) !== local.checksum
      || view.getUint32(offset + 20, true) !== local.byteLength
      || view.getUint32(offset + 24, true) !== local.byteLength
      || nameLength !== local.name.byteLength
      || extraLength !== 0
      || commentLength !== 0
      || view.getUint16(offset + 34, true) !== 0
      || view.getUint16(offset + 36, true) !== 0
      || view.getUint32(offset + 38, true) !== 0
      || view.getUint32(offset + 42, true) !== local.localOffset
      || !sameBytes(archive.slice(nameStart, nameEnd), local.name)) {
      throw new BridgeSessionError("invalid_publication", `Bridge exchange ZIP directory entry for ${local.path} is invalid`);
    }
    offset = recordEnd;
  }
  const centralSize = offset - centralOffset;
  if (offset + 22 !== archive.byteLength
    || view.getUint32(offset, true) !== 0x06054b50
    || view.getUint16(offset + 4, true) !== 0
    || view.getUint16(offset + 6, true) !== 0
    || view.getUint16(offset + 8, true) !== directoryEntries.length
    || view.getUint16(offset + 10, true) !== directoryEntries.length
    || view.getUint32(offset + 12, true) !== centralSize
    || view.getUint32(offset + 16, true) !== centralOffset
    || view.getUint16(offset + 20, true) !== 0) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP end record is invalid");
  }
  return entries;
}

function assertExchangeContents(value: BridgePublication): void {
  const entries = readExchangeEntries(value.archive);
  const expectedManifest = bridgeJsonBytes(value.manifest);
  const embeddedManifest = entries.get(SEMAFRAME_EXCHANGE_PATHS.manifest);
  if (!embeddedManifest || !sameBytes(embeddedManifest, expectedManifest)) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange embedded manifest does not match the publication");
  }
  const expectedPaths = new Set<string>([SEMAFRAME_EXCHANGE_PATHS.manifest]);
  for (const descriptor of value.manifest.files) {
    try {
      assertSafeExchangePath(descriptor.path);
    } catch {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange manifest contains an unsafe file path");
    }
    if (expectedPaths.has(descriptor.path)) {
      throw new BridgeSessionError("invalid_publication", "Bridge exchange manifest repeats a file path");
    }
    expectedPaths.add(descriptor.path);
    const bytes = entries.get(descriptor.path);
    if (!bytes || bytes.byteLength !== descriptor.byteLength || publicationDigest(bytes) !== descriptor.sha256) {
      throw new BridgeSessionError("invalid_publication", `Bridge exchange file ${descriptor.path} does not match its manifest`);
    }
  }
  if (entries.size !== expectedPaths.size || [...entries.keys()].some((path) => !expectedPaths.has(path))) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange ZIP contains files outside its manifest");
  }
}

function assertManifestShape(manifest: SemaFrameExchangeManifest): void {
  let encoded: Uint8Array;
  try {
    encoded = bridgeJsonBytes(manifest);
  } catch {
    throw new BridgeSessionError("invalid_publication", "Bridge manifest must be canonical acyclic JSON");
  }
  if (encoded.byteLength > 4 * 1024 * 1024
    || manifest.format !== SEMAFRAME_EXCHANGE_FORMAT
    || manifest.version !== SEMAFRAME_EXCHANGE_VERSION
    || manifest.generator?.name !== "SemaFrame"
    || !manifest.source || typeof manifest.source.workspaceId !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(manifest.source.workspaceDigest)
    || !Array.isArray(manifest.nodes) || manifest.nodes.length > SEMAFRAME_EXCHANGE_LIMITS.maximumComponents
    || !Array.isArray(manifest.resources) || manifest.resources.length > SEMAFRAME_EXCHANGE_LIMITS.maximumResources
    || !Array.isArray(manifest.connections) || manifest.connections.length > SEMAFRAME_EXCHANGE_LIMITS.maximumConnections
    || !Array.isArray(manifest.files) || manifest.files.length > 8
    || manifest.coordinateSystem?.units !== "metre"
    || manifest.coordinateSystem?.handedness !== "right"
    || manifest.coordinateSystem?.upAxis !== "Y"
    || manifest.coordinateSystem?.angles !== "radian"
    || manifest.roundTrip?.stableIds !== true
    || manifest.roundTrip?.directMutation !== false
    || manifest.roundTrip?.editsReturnAs !== "reviewable_change_proposal") {
    throw new BridgeSessionError("invalid_publication", "Bridge manifest shape or limits are invalid");
  }
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.mediaType !== "string"
      || file.mediaType.length < 3 || file.mediaType.length > 192
      || !Number.isSafeInteger(file.byteLength) || file.byteLength < 1
      || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new BridgeSessionError("invalid_publication", "Bridge manifest file descriptor is invalid");
    }
  }
}

function assertPublication(value: BridgePublication): void {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new BridgeSessionError("invalid_publication", "Bridge publication sequence must be positive");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.workspaceId) {
    throw new BridgeSessionError("invalid_publication", "Bridge publication source is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.exchangeDigest)) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange digest is invalid");
  }
  assertManifestShape(value.manifest);
  if (value.archive.byteLength < 22 || value.archive.byteLength > BRIDGE_SESSION_LIMITS.maximumArchiveBytes) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange archive is outside the size limit");
  }
  if (new DataView(value.archive.buffer, value.archive.byteOffset, value.archive.byteLength).getUint32(0, true) !== 0x04034b50) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange archive must be a non-empty ZIP package");
  }
  if (publicationDigest(value.archive) !== value.exchangeDigest) {
    throw new BridgeSessionError("invalid_publication", "Bridge exchange archive digest does not match the publication");
  }
  if (value.manifest.source.workspaceId !== value.workspaceId
    || value.manifest.source.revision !== value.revision) {
    throw new BridgeSessionError("invalid_publication", "Bridge manifest and publication source disagree");
  }
  assertExchangeContents(value);
}

function sessionView(session: MutableSession): BridgeSessionView {
  const publication = session.publication;
  return Object.freeze({
    sessionId: session.sessionId,
    target: session.target,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    publication: Object.freeze({
      sequence: publication.sequence,
      workspaceId: publication.workspaceId,
      revision: publication.revision,
      exchangeDigest: publication.exchangeDigest,
      manifest: structuredClone(publication.manifest),
      byteLength: publication.archive.byteLength,
    }),
  });
}

/**
 * Host-owned pull bridge. Native tools can fetch immutable exchanges and submit
 * edits, while only the Workspace owner can publish, inspect, or close a link.
 */
export class BridgeSessionService {
  readonly #sessions = new Map<string, MutableSession>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  create(
    ownerId: string,
    target: SemaFrameBridgeTarget,
    publication: BridgePublication,
    ttlMs = BRIDGE_SESSION_LIMITS.defaultTtlMs,
  ): BridgeSessionAccess {
    this.purgeExpired();
    if (!ownerId || !["blender", "freecad", "unity", "unreal", "custom"].includes(target)) {
      throw new BridgeSessionError("invalid_publication", "Bridge owner or target is invalid");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > BRIDGE_SESSION_LIMITS.maximumTtlMs) {
      throw new BridgeSessionError("invalid_publication", "Bridge session TTL is invalid");
    }
    if (this.#sessions.size >= BRIDGE_SESSION_LIMITS.maximumSessions) {
      throw new BridgeSessionError("capacity_exceeded", "Too many Bridge sessions are active");
    }
    assertPublication(publication);
    const sessionId = randomUUID();
    const bearer = randomBytes(32).toString("base64url");
    const expiresAtMs = this.#now() + ttlMs;
    this.#sessions.set(sessionId, {
      sessionId,
      ownerId,
      target,
      tokenHash: tokenHash(bearer),
      expiresAtMs,
      publication: copyPublication(publication),
      proposalCursor: 0,
      proposals: [],
    });
    return Object.freeze({
      sessionId,
      bearer,
      target,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  publish(ownerId: string, sessionId: string, publication: BridgePublication): BridgeSessionView {
    const session = this.#owned(ownerId, sessionId);
    assertPublication(publication);
    if (publication.workspaceId !== session.publication.workspaceId) {
      throw new BridgeSessionError("invalid_publication", "A Bridge session cannot change Workspace identity");
    }
    if (publication.sequence <= session.publication.sequence || publication.revision < session.publication.revision) {
      throw new BridgeSessionError("stale_publication", "Bridge publications must advance sequence and never rewind revision");
    }
    session.publication = copyPublication(publication);
    return sessionView(session);
  }

  inspect(ownerId: string, sessionId: string): BridgeSessionView {
    return sessionView(this.#owned(ownerId, sessionId));
  }

  pull(sessionId: string, bearer: string, afterSequence?: number): BridgeSessionView | undefined {
    const session = this.#authorized(sessionId, bearer);
    if (afterSequence !== undefined
      && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      throw new BridgeSessionError("invalid_publication", "Bridge sequence cursor is invalid");
    }
    return afterSequence !== undefined && afterSequence >= session.publication.sequence
      ? undefined
      : sessionView(session);
  }

  readArchive(sessionId: string, bearer: string, expectedDigest?: string): Uint8Array {
    const session = this.#authorized(sessionId, bearer);
    if (expectedDigest !== undefined && expectedDigest !== session.publication.exchangeDigest) {
      throw new BridgeSessionError("proposal_mismatch", "Requested exchange digest is no longer current");
    }
    const bytes = new Uint8Array(session.publication.archive.byteLength);
    bytes.set(session.publication.archive);
    return bytes;
  }

  submitProposal(sessionId: string, bearer: string, value: unknown): BridgeProposalRecord {
    const session = this.#authorized(sessionId, bearer);
    if (session.proposals.length >= BRIDGE_SESSION_LIMITS.maximumPendingProposals) {
      throw new BridgeSessionError("capacity_exceeded", "The Bridge proposal queue is full");
    }
    let proposal: SemaFrameBridgeChangeProposal;
    try {
      proposal = parseSemaFrameBridgeChangeProposal(value);
    } catch (cause) {
      if (!(cause instanceof TypeError) && !(cause instanceof RangeError)) throw cause;
      throw new BridgeSessionError(
        "invalid_proposal",
        "Bridge proposal does not match the supported bounded JSON contract",
      );
    }
    if (proposal.target !== session.target
      || proposal.source.workspaceId !== session.publication.workspaceId
      || proposal.source.baseRevision !== session.publication.revision
      || proposal.source.exchangeDigest !== session.publication.exchangeDigest) {
      throw new BridgeSessionError("proposal_mismatch", "Bridge proposal does not match the current publication");
    }
    const record = Object.freeze({
      cursor: ++session.proposalCursor,
      receivedAt: new Date(this.#now()).toISOString(),
      proposal,
    });
    session.proposals.push(record);
    return structuredClone(record);
  }

  readProposals(ownerId: string, sessionId: string, afterCursor = 0): readonly BridgeProposalRecord[] {
    const session = this.#owned(ownerId, sessionId);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new BridgeSessionError("invalid_publication", "Bridge proposal cursor is invalid");
    }
    return Object.freeze(session.proposals
      .filter((record) => record.cursor > afterCursor)
      .map((record) => structuredClone(record)));
  }

  discardProposals(ownerId: string, sessionId: string, throughCursor: number): void {
    const session = this.#owned(ownerId, sessionId);
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) {
      throw new BridgeSessionError("invalid_publication", "Bridge proposal cursor is invalid");
    }
    session.proposals = session.proposals.filter((record) => record.cursor > throughCursor);
  }

  close(ownerId: string, sessionId: string): void {
    this.#owned(ownerId, sessionId);
    this.#sessions.delete(sessionId);
  }

  revokeOwner(ownerId: string): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.ownerId === ownerId) this.#sessions.delete(sessionId);
    }
  }

  purgeExpired(): void {
    const now = this.#now();
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAtMs <= now) this.#sessions.delete(sessionId);
    }
  }

  #owned(ownerId: string, sessionId: string): MutableSession {
    this.purgeExpired();
    const session = this.#sessions.get(sessionId);
    if (!session) throw new BridgeSessionError("session_not_found", "Bridge session was not found");
    if (session.ownerId !== ownerId) throw new BridgeSessionError("unauthorized", "Bridge owner authorization failed");
    return session;
  }

  #authorized(sessionId: string, bearer: string): MutableSession {
    const before = this.#sessions.get(sessionId);
    if (before && before.expiresAtMs <= this.#now()) {
      this.#sessions.delete(sessionId);
      throw new BridgeSessionError("session_expired", "Bridge session expired");
    }
    const session = this.#sessions.get(sessionId);
    if (!session) throw new BridgeSessionError("session_not_found", "Bridge session was not found");
    if (!bearer || !tokenMatches(bearer, session.tokenHash)) {
      throw new BridgeSessionError("unauthorized", "Bridge bearer authorization failed");
    }
    return session;
  }
}
