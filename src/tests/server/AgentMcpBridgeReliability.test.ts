import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  AgentMcpToolCatalogRefreshCoordinator,
  classifyAgentMcpUpstreamFailure,
  executeAgentMcpUpstreamCall,
} from "../../../server/agent/AgentMcpBridgeReliability";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Agent MCP bridge reliability", () => {
  it("never lets an older tools/list response overwrite a newer catalog", async () => {
    const coordinator = new AgentMcpToolCatalogRefreshCoordinator<object>();
    const client = {};
    const older = deferred<readonly string[]>();
    const newer = deferred<readonly string[]>();
    const applied: string[][] = [];

    const olderRefresh = coordinator.refresh(client, () => older.promise, (catalog) => {
      applied.push([...catalog]);
    });
    const newerRefresh = coordinator.refresh(client, () => newer.promise, (catalog) => {
      applied.push([...catalog]);
    });

    newer.resolve(["current"]);
    await expect(newerRefresh).resolves.toBe("applied");
    older.resolve(["stale"]);
    await expect(olderRefresh).resolves.toBe("superseded");
    expect(applied).toEqual([["current"]]);
  });

  it("suppresses a superseded refresh failure instead of invalidating a newer catalog", async () => {
    const coordinator = new AgentMcpToolCatalogRefreshCoordinator<object>();
    const client = {};
    const older = deferred<readonly string[]>();
    const applied: string[][] = [];
    const olderRefresh = coordinator.refresh(client, () => older.promise, (catalog) => {
      applied.push([...catalog]);
    });
    await expect(coordinator.refresh(
      client,
      async () => ["current"],
      (catalog) => { applied.push([...catalog]); },
    )).resolves.toBe("applied");

    older.reject(new Error("late failure"));
    await expect(olderRefresh).resolves.toBe("superseded");
    expect(applied).toEqual([["current"]]);
  });

  it("keeps every received JSON-RPC error local while a concurrent call completes", async () => {
    const slowResult = deferred<string>();
    const reconnect = vi.fn(async () => "connection failure");
    const requestFailure = vi.fn(() => "request failure");

    const slow = executeAgentMcpUpstreamCall({
      invoke: () => slowResult.promise,
      onRequestError: requestFailure,
      onConnectionError: reconnect,
    });
    const rejected = [
      ProtocolErrorCode.InvalidParams,
      ProtocolErrorCode.InternalError,
      ProtocolErrorCode.ParseError,
    ].map((code) => executeAgentMcpUpstreamCall({
      invoke: async () => {
        throw new ProtocolError(code, "upstream-controlled secret or prompt text");
      },
      onRequestError: requestFailure,
      onConnectionError: reconnect,
    }));

    await expect(Promise.all(rejected)).resolves.toEqual([
      "request failure",
      "request failure",
      "request failure",
    ]);
    slowResult.resolve("slow success");
    await expect(slow).resolves.toBe("slow success");
    expect(requestFailure).toHaveBeenCalledTimes(3);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("propagates request cancellation without entering the shared reconnect path", async () => {
    const controller = new AbortController();
    const reconnect = vi.fn(() => "connection failure");
    const requestFailure = vi.fn(() => "request failure");
    const cancelled = executeAgentMcpUpstreamCall({
      signal: controller.signal,
      invoke: async () => await new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason);
        }, { once: true });
      }),
      onRequestError: requestFailure,
      onConnectionError: reconnect,
    });
    const sibling = executeAgentMcpUpstreamCall({
      invoke: async () => "sibling success",
      onRequestError: requestFailure,
      onConnectionError: reconnect,
    });

    controller.abort(new DOMException("cancelled downstream", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(sibling).resolves.toBe("sibling success");
    expect(requestFailure).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("distinguishes received protocol responses and deterministic SDK failures from transport failures", () => {
    expect(classifyAgentMcpUpstreamFailure(
      new ProtocolError(ProtocolErrorCode.InternalError, "upstream unavailable"),
    )).toBe("request");
    expect(classifyAgentMcpUpstreamFailure(
      new ProtocolError(ProtocolErrorCode.ParseError, "upstream parse response"),
    )).toBe("request");
    expect(classifyAgentMcpUpstreamFailure(
      new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, "removed method"),
    )).toBe("request");
    expect(classifyAgentMcpUpstreamFailure(
      new SdkError(SdkErrorCode.ConnectionClosed, "closed"),
    )).toBe("connection");
  });
});
