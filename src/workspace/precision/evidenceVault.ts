import { digestBlobSha256 } from "../assets/digest";

export type PrecisionEvidenceRef = Readonly<{
  digest: `sha256:${string}`;
  byteLength: number;
  kind: "capture-bundle" | "measurement-source";
  mediaType: string;
}>;

export const PRECISION_EVIDENCE_LIMITS = Object.freeze({ maximumBytes: 256 * 1024 * 1024, maximumReferences: 32 });

export function parsePrecisionEvidenceRef(value: unknown): PrecisionEvidenceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid precision evidence reference");
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).sort().join(",") !== "byteLength,digest,kind,mediaType"
    || typeof ref.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(ref.digest)
    || !Number.isSafeInteger(ref.byteLength) || Number(ref.byteLength) < 1 || Number(ref.byteLength) > PRECISION_EVIDENCE_LIMITS.maximumBytes
    || !["capture-bundle", "measurement-source"].includes(String(ref.kind))
    || typeof ref.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(ref.mediaType)
    || ref.mediaType.length > 128
    || (ref.kind === "capture-bundle" && ref.mediaType !== "application/vnd.semaframe.capture+zip")) {
    throw new Error("Invalid precision evidence reference");
  }
  return structuredClone(ref) as PrecisionEvidenceRef;
}

export interface PrecisionEvidenceVault {
  open(ref: PrecisionEvidenceRef): Promise<Blob>;
  put(ref: PrecisionEvidenceRef, blob: Blob): Promise<{ inserted: boolean }>;
  delete(digest: string): Promise<void>;
}

export async function verifyPrecisionEvidence(refInput: PrecisionEvidenceRef, blob: Blob): Promise<void> {
  const ref = parsePrecisionEvidenceRef(refInput);
  if (blob.size !== ref.byteLength || await digestBlobSha256(blob, { maximumBytes: PRECISION_EVIDENCE_LIMITS.maximumBytes }) !== ref.digest) {
    throw new Error("Precision evidence bytes do not match their SHA-256 reference");
  }
}

/** Dedicated CAS. A digest proves byte integrity, not that a measurement is truthful. */
export class BrowserPrecisionEvidenceVault implements PrecisionEvidenceVault {
  private database?: Promise<IDBDatabase>;

  private db(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("Precision evidence storage is unavailable")); return; }
      const request = indexedDB.open("semaframe-precision-evidence-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("objects");
      request.onerror = () => { this.database = undefined; reject(request.error ?? new Error("Evidence storage failed")); };
      request.onsuccess = () => resolve(request.result);
    });
  }

  private async read(digest: string): Promise<Blob | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("objects", "readonly");
      const request = transaction.objectStore("objects").get(digest);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as Blob | undefined);
    });
  }

  async open(ref: PrecisionEvidenceRef): Promise<Blob> {
    parsePrecisionEvidenceRef(ref);
    const blob = await this.read(ref.digest);
    if (!blob) throw new Error(`Missing precision evidence ${ref.digest}`);
    await verifyPrecisionEvidence(ref, blob);
    return blob;
  }

  async put(ref: PrecisionEvidenceRef, blob: Blob): Promise<{ inserted: boolean }> {
    await verifyPrecisionEvidence(ref, blob);
    const db = await this.db();
    const result = await new Promise<{ inserted: boolean; existing?: Blob }>((resolve, reject) => {
      const tx = db.transaction("objects", "readwrite");
      const objects = tx.objectStore("objects");
      const request = objects.get(ref.digest);
      let existing: Blob | undefined;
      request.onsuccess = () => {
        existing = request.result as Blob | undefined;
        if (!existing) objects.add(blob.slice(0, blob.size, ref.mediaType), ref.digest);
      };
      tx.oncomplete = () => resolve({ inserted: !existing, existing });
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Evidence storage failed"));
    });
    if (result.existing) await verifyPrecisionEvidence(ref, result.existing);
    return { inserted: result.inserted };
  }

  async delete(digest: string): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("objects", "readwrite");
      tx.objectStore("objects").delete(digest);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
}

export class MemoryPrecisionEvidenceVault implements PrecisionEvidenceVault {
  private readonly objects = new Map<string, Blob>();
  async open(ref: PrecisionEvidenceRef): Promise<Blob> {
    const blob = this.objects.get(ref.digest);
    if (!blob) throw new Error(`Missing precision evidence ${ref.digest}`);
    await verifyPrecisionEvidence(ref, blob);
    return blob;
  }
  async put(ref: PrecisionEvidenceRef, blob: Blob): Promise<{ inserted: boolean }> {
    await verifyPrecisionEvidence(ref, blob);
    const inserted = !this.objects.has(ref.digest);
    this.objects.set(ref.digest, blob);
    return { inserted };
  }
  async delete(digest: string): Promise<void> { this.objects.delete(digest); }
}

let browserVault: BrowserPrecisionEvidenceVault | undefined;
export function defaultPrecisionEvidenceVault(): PrecisionEvidenceVault {
  return browserVault ??= new BrowserPrecisionEvidenceVault();
}
