import type {
  WorkspaceRecoveryReadResult,
  WorkspaceRecoveryRepository,
  WorkspaceRecoverySnapshot,
} from "./WorkspaceRecoveryRepository";
import { migrateLegacyWorkspaceRecovery } from "./WorkspaceRecoveryRepository";

export type WorkspaceRecoveryWriteResult =
  | Readonly<{ status: "stored"; generation: number; sequence: number }>
  | Readonly<{ status: "stale" | "superseded"; generation: number; sequence: number }>;

type PendingWrite = Readonly<{
  snapshot: WorkspaceRecoverySnapshot;
  resolve: (result: WorkspaceRecoveryWriteResult) => void;
  reject: (error: unknown) => void;
}>;

/**
 * Serializes recovery mutations and makes project replacement a hard boundary.
 * A stale generation is never written after clear/replace, even if an older
 * caller finishes producing a snapshot late.
 */
export class WorkspaceRecoveryCoordinator {
  private generation = 0;
  private sequence = 0;
  private pending: PendingWrite | undefined;
  private draining: Promise<void> | undefined;
  private barrier: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly repository: WorkspaceRecoveryRepository) {}

  currentGeneration(): number { return this.generation; }

  async read(): Promise<WorkspaceRecoveryReadResult | undefined> {
    this.assertOpen();
    await this.flush();
    return this.repository.read();
  }

  async readCandidates(): Promise<readonly WorkspaceRecoveryReadResult[]> {
    this.assertOpen();
    await this.flush();
    return this.repository.readCandidates();
  }

  async migrateLegacy(raw: string, removeLegacy: () => void | Promise<void>): Promise<boolean> {
    this.assertOpen();
    await this.flush();
    return migrateLegacyWorkspaceRecovery(this.repository, raw, removeLegacy);
  }

  schedule(snapshot: Omit<WorkspaceRecoverySnapshot, "generation" | "sequence">): Promise<WorkspaceRecoveryWriteResult> {
    this.assertOpen();
    const generation = this.generation;
    const sequence = ++this.sequence;
    return new Promise<WorkspaceRecoveryWriteResult>((resolve, reject) => {
      if (this.pending) {
        this.pending.resolve({
          status: "superseded",
          generation: this.pending.snapshot.generation,
          sequence: this.pending.snapshot.sequence,
        });
      }
      this.pending = Object.freeze({
        snapshot: Object.freeze({ ...snapshot, generation, sequence }),
        resolve,
        reject,
      });
      this.startDrain();
    });
  }

  async replaceGeneration(options: Readonly<{ clear: boolean }> = { clear: false }): Promise<number> {
    this.assertOpen();
    this.generation += 1;
    this.sequence = 0;
    if (this.pending) {
      this.pending.resolve({
        status: "stale",
        generation: this.pending.snapshot.generation,
        sequence: this.pending.snapshot.sequence,
      });
      this.pending = undefined;
    }
    await this.flush();
    if (options.clear) {
      this.barrier = this.barrier.then(() => this.repository.clear());
      await this.barrier;
    }
    return this.generation;
  }

  async clear(): Promise<void> {
    await this.replaceGeneration({ clear: true });
  }

  async flush(): Promise<void> {
    await this.draining;
    await this.barrier;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
    this.repository.dispose();
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const job = this.pending;
      this.pending = undefined;
      if (job.snapshot.generation !== this.generation) {
        job.resolve({ status: "stale", generation: job.snapshot.generation, sequence: job.snapshot.sequence });
        continue;
      }
      try {
        this.barrier = this.barrier.then(async () => {
          if (job.snapshot.generation !== this.generation) return;
          await this.repository.write(job.snapshot);
        });
        await this.barrier;
        job.resolve({
          status: job.snapshot.generation === this.generation ? "stored" : "stale",
          generation: job.snapshot.generation,
          sequence: job.snapshot.sequence,
        });
      } catch (error) {
        job.reject(error);
      }
    }
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // A caller awaiting the just-completed job can enqueue a new snapshot
      // before this finalizer runs. Start another pump instead of leaving that
      // snapshot pending forever at the microtask boundary.
      if (this.pending && !this.disposed) this.startDrain();
    });
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Workspace recovery coordinator is disposed");
  }
}
