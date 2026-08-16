import type { AssetCandidate, EntityKind } from "../renderer/sceneRenderTypes";
import {
  ASSET_MANIFEST,
  NEUTRAL_LOW_POLY_STYLE,
  assertAssetManifest,
  type AssetManifest,
  type AssetRecord,
} from "./assetManifest";

export type AssetSearchQuery = {
  query: string;
  kind: EntityKind;
  styleFamily?: string;
  limit?: number;
};

export type ResolvedAsset = {
  assetId: string;
  record: AssetRecord;
  approximated: boolean;
  score: number;
};

const FALLBACK_BY_KIND: Record<EntityKind, string> = {
  character: "fallback_character_capsule",
  animal: "animal_quadruped_generic",
  prop: "fallback_prop_box",
  structure: "fallback_structure_box",
  effect: "fallback_effect_sphere",
  primitive: "primitive_box",
};

const TOKEN_EQUIVALENTS: Record<string, readonly string[]> = {
  automobile: ["car", "vehicle"],
  canine: ["dog"],
  couch: ["sofa"],
  desk: ["table"],
  female: ["woman", "person"],
  gentleman: ["man", "person"],
  guy: ["man", "person"],
  lady: ["woman", "person"],
  male: ["man", "person"],
  person: ["human", "humanoid"],
};

export function normalizeAssetText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") ?? "";
}

function tokenize(value: string): Set<string> {
  const normalized = normalizeAssetText(value);
  const tokens = new Set(normalized ? normalized.split(" ") : []);
  for (const token of [...tokens]) {
    for (const equivalent of TOKEN_EQUIVALENTS[token] ?? []) {
      tokens.add(equivalent);
    }
  }
  return tokens;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoreAsset(record: AssetRecord, query: string): number {
  const normalizedQuery = normalizeAssetText(query);
  if (!normalizedQuery) return 0;

  const normalizedName = normalizeAssetText(record.displayName);
  const normalizedTags = record.tags.map(normalizeAssetText);
  if (normalizedName === normalizedQuery) return 1;
  if (normalizedTags.includes(normalizedQuery)) return 0.97;

  const queryTokens = tokenize(query);
  const nameTokens = tokenize(record.displayName);
  // The interpreter is encouraged to include style intent (for example
  // "low poly") in assetQuery. Index the manifest's style family so a bundled
  // exact-family match is not incorrectly reported as an approximation.
  const corpusTokens = tokenize(
    `${record.displayName} ${record.tags.join(" ")} ${record.styleFamily}`,
  );
  let overlap = 0;
  let nameOverlap = 0;
  for (const token of queryTokens) {
    if (corpusTokens.has(token)) overlap += 1;
    if (nameTokens.has(token)) nameOverlap += 1;
  }
  if (overlap === 0) return 0;

  const queryCoverage = overlap / queryTokens.size;
  const nameCoverage = nameOverlap / queryTokens.size;
  const specificity = overlap / Math.max(corpusTokens.size, queryTokens.size);
  const fallbackPenalty = record.fallback ? 0.12 : 0;
  return Math.max(
    0,
    Math.min(0.96, queryCoverage * 0.72 + nameCoverage * 0.2 + specificity * 0.08 - fallbackPenalty),
  );
}

/** Deterministic, local semantic index over the versioned asset manifest. */
export class AssetRegistry {
  readonly libraryVersion: string;
  readonly styleFamily: string;
  private readonly recordsById: ReadonlyMap<string, AssetRecord>;
  private readonly orderedRecords: readonly AssetRecord[];

  constructor(manifest: AssetManifest = ASSET_MANIFEST) {
    assertAssetManifest(manifest);
    this.libraryVersion = manifest.assetLibraryVersion;
    this.styleFamily = manifest.styleFamily;
    const ordered = [...manifest.assets].sort((a, b) => stableCompare(a.assetId, b.assetId));
    const map = new Map<string, AssetRecord>();
    for (const record of ordered) {
      if (map.has(record.assetId)) {
        throw new Error(`Duplicate assetId: ${record.assetId}`);
      }
      map.set(record.assetId, Object.freeze({
        ...record,
        tags: Object.freeze([...record.tags]) as unknown as string[],
        anchors: Object.freeze([...record.anchors]) as unknown as string[],
        sockets: Object.freeze([...record.sockets]) as unknown as string[],
        animations: Object.freeze([...record.animations]) as unknown as AssetRecord["animations"],
        supportedStates: Object.freeze([...record.supportedStates]) as unknown as string[],
        variants: Object.freeze([...record.variants]) as unknown as string[],
      }));
    }
    this.orderedRecords = Object.freeze([...map.values()]);
    this.recordsById = map;

    for (const [kind, assetId] of Object.entries(FALLBACK_BY_KIND)) {
      const fallback = map.get(assetId);
      if (!fallback || fallback.kind !== kind) {
        throw new Error(`Asset manifest needs ${kind} fallback ${assetId}`);
      }
    }
  }

  get(assetId: string): AssetRecord | null {
    return this.recordsById.get(assetId) ?? null;
  }

  require(assetId: string): AssetRecord {
    const record = this.get(assetId);
    if (!record) throw new Error(`Unknown assetId: ${assetId}`);
    return record;
  }

  all(): readonly AssetRecord[] {
    return this.orderedRecords;
  }

  fallback(kind: EntityKind): AssetRecord {
    return this.require(FALLBACK_BY_KIND[kind]);
  }

  search(searchQuery: AssetSearchQuery): AssetCandidate[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(searchQuery.limit ?? 5)));
    const styleFamily = searchQuery.styleFamily;
    return this.orderedRecords
      .filter((record) => record.kind === searchQuery.kind)
      .filter((record) => !styleFamily || record.styleFamily === styleFamily)
      .map((record) => ({ assetId: record.assetId, score: scoreAsset(record, searchQuery.query) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || stableCompare(a.assetId, b.assetId))
      .slice(0, limit)
      .map((candidate) => ({ ...candidate, score: Number(candidate.score.toFixed(6)) }));
  }

  resolve(searchQuery: AssetSearchQuery): ResolvedAsset {
    const candidate = this.search({ ...searchQuery, limit: 1 })[0];
    if (candidate) {
      const record = this.require(candidate.assetId);
      return {
        assetId: record.assetId,
        record,
        approximated: Boolean(record.fallback) || candidate.score < 0.72,
        score: candidate.score,
      };
    }

    const record = this.fallback(searchQuery.kind);
    return {
      assetId: record.assetId,
      record,
      approximated: true,
      score: 0,
    };
  }

  isCompatibleLibrary(version: string): boolean {
    return version === this.libraryVersion;
  }
}

export const DEFAULT_ASSET_REGISTRY = new AssetRegistry();
export { FALLBACK_BY_KIND, NEUTRAL_LOW_POLY_STYLE };
