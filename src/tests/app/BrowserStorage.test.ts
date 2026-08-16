import { describe, expect, it, vi } from "vitest";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "../../app/browserStorage";

describe("browser storage resilience", () => {
  it("fails closed without throwing when storage is blocked or full", () => {
    const blocked = {
      getItem: vi.fn(() => { throw new DOMException("blocked", "SecurityError"); }),
      setItem: vi.fn(() => { throw new DOMException("full", "QuotaExceededError"); }),
      removeItem: vi.fn(() => { throw new DOMException("blocked", "SecurityError"); }),
    };
    expect(safeStorageGet("project", blocked)).toBeNull();
    expect(safeStorageSet("project", "payload", blocked)).toBe(false);
    expect(safeStorageRemove("project", blocked)).toBe(false);
  });

  it("reports successful storage operations", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    expect(safeStorageSet("project", "payload", storage)).toBe(true);
    expect(safeStorageGet("project", storage)).toBe("payload");
    expect(safeStorageRemove("project", storage)).toBe(true);
    expect(safeStorageGet("project", storage)).toBeNull();
  });
});
