import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer, type Tool } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { describe, expect, it, vi } from "vitest";
import {
  AgentMcpToolMirror,
  AgentMcpToolMirrorError,
  trackAgentMcpToolMirrorLifecycle,
} from "../../../server/agent/AgentMcpToolMirror";

function definition(name: string, description = `${name} description`): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["echo"],
      properties: { echo: { type: "string" } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

describe("AgentMcpToolMirror", () => {
  it("adds, updates, calls, and removes tools without replacing the stdio server", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const server = new McpServer({ name: "mirror-test", version: "1.0.0" });
    const mirror = new AgentMcpToolMirror(server, async (name, input) => {
      calls.push({ name, input });
      return {
        content: [{ type: "text", text: JSON.stringify({ echo: input.value }) }],
        structuredContent: { echo: input.value },
      };
    });
    expect(mirror.synchronize([definition("alpha")])).toMatchObject({
      changed: true,
      added: ["alpha"],
      updated: [],
      removed: [],
    });

    const changes: string[][] = [];
    const client = new Client(
      { name: "mirror-client", version: "1.0.0" },
      {
        versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } },
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error, tools) => {
              if (!error && tools) changes.push(tools.map(({ name }) => name).sort());
            },
          },
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["alpha"]);
      expect(await client.callTool({ name: "alpha", arguments: { value: "one" } }))
        .toMatchObject({ structuredContent: { echo: "one" } });

      const changed = mirror.synchronize([
        definition("alpha", "updated alpha"),
        definition("beta"),
      ]);
      expect(changed).toMatchObject({ changed: true, added: ["beta"], updated: ["alpha"], removed: [] });
      await vi.waitFor(() => expect(changes.at(-1)).toEqual(["alpha", "beta"]));
      expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(["alpha", "beta"]);

      expect(mirror.synchronize([definition("beta")])).toMatchObject({
        changed: true,
        added: [],
        updated: [],
        removed: ["alpha"],
      });
      await vi.waitFor(() => expect(changes.at(-1)).toEqual(["beta"]));
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["beta"]);
      expect(calls).toEqual([{ name: "alpha", input: { value: "one" } }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("can adopt an existing static registration and replace its schema and callback", async () => {
    const server = new McpServer({ name: "seed-test", version: "1.0.0" });
    const original = server.registerTool(
      "alpha",
      { inputSchema: z.strictObject({ legacy: z.boolean() }) },
      async () => ({ content: [{ type: "text", text: "legacy" }] }),
    );
    const call = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: "mirrored" }],
      structuredContent: { echo: input.value },
    }));
    const mirror = new AgentMcpToolMirror(server, call);
    mirror.seed("alpha", original);
    expect(mirror.synchronize([definition("alpha")])).toMatchObject({ updated: ["alpha"] });

    const client = new Client(
      { name: "seed-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools[0]?.inputSchema).toMatchObject({ required: ["value"] });
      expect(await client.callTool({ name: "alpha", arguments: { value: "current" } }))
        .toMatchObject({ structuredContent: { echo: "current" } });
      expect(call).toHaveBeenCalledWith("alpha", { value: "current" }, expect.any(AbortSignal));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects duplicate, oversized, and malformed upstream catalogs without mutation", () => {
    const server = new McpServer({ name: "invalid-test", version: "1.0.0" });
    const mirror = new AgentMcpToolMirror(server, async () => ({ content: [] }), {
      maximumTools: 2,
      maximumCatalogBytes: 1_024,
    });
    expect(() => mirror.synchronize([definition("same"), definition("same")]))
      .toThrow(AgentMcpToolMirrorError);
    expect(() => mirror.synchronize([definition("one"), definition("two"), definition("three")]))
      .toThrow(/tool count/u);
    expect(() => mirror.synchronize([{ ...definition("valid"), name: "bad name" }]))
      .toThrow(/name is invalid/u);
    expect(() => mirror.synchronize([{ ...definition("valid"), inputSchema: null as never }]))
      .toThrow(/inputSchema/u);

    expect(mirror.synchronize([definition("kept")])).toMatchObject({ added: ["kept"] });
    expect(() => mirror.synchronize([
      definition("would-have-been-added"),
      { ...definition("invalid-late"), inputSchema: null as never },
    ])).toThrow(/inputSchema/u);
    expect(mirror.synchronize([definition("kept")])).toMatchObject({
      changed: false,
      added: [],
      updated: [],
      removed: [],
    });
  });

  it("clears optional output validation and metadata when an upstream definition removes them", async () => {
    const server = new McpServer({ name: "clear-test", version: "1.0.0" });
    const mirror = new AgentMcpToolMirror(server, async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { any: "shape" },
    }));
    mirror.synchronize([definition("alpha")]);

    let refreshedTools: Tool[] | undefined;
    const client = new Client(
      { name: "clear-client", version: "1.0.0" },
      {
        versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } },
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error, tools) => {
              if (!error && tools) refreshedTools = tools;
            },
          },
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      mirror.synchronize([{
        name: "alpha",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }]);
      await vi.waitFor(() => {
        expect(refreshedTools).toHaveLength(1);
        expect(refreshedTools?.[0]?.description).toBeUndefined();
      });
      const tool = refreshedTools?.[0];
      expect(tool).toBeDefined();
      // The in-memory client decoder can materialize omitted optional keys as
      // undefined. Their semantic value (and JSON wire value) is still absent.
      expect(tool?.description).toBeUndefined();
      expect(tool?.outputSchema).toBeUndefined();
      expect(tool?.annotations).toBeUndefined();
      await expect(client.callTool({ name: "alpha", arguments: {} })).resolves.toMatchObject({
        structuredContent: { any: "shape" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards downstream cancellation to only the matching mirrored call", async () => {
    let markLongStarted!: () => void;
    const longStarted = new Promise<void>((resolve) => { markLongStarted = resolve; });
    const calls: string[] = [];
    const server = new McpServer({ name: "cancellation-test", version: "1.0.0" });
    const mirror = new AgentMcpToolMirror(server, async (_name, input, signal) => {
      const value = String(input.value);
      calls.push(value);
      if (value === "long") {
        markLongStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException("cancelled", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return {
        content: [{ type: "text", text: value }],
        structuredContent: { echo: value },
      };
    });
    mirror.synchronize([definition("alpha")]);

    const client = new Client(
      { name: "cancellation-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const controller = new AbortController();
      const longCall = client.callTool(
        { name: "alpha", arguments: { value: "long" } },
        { signal: controller.signal },
      );
      await longStarted;
      const sibling = client.callTool({ name: "alpha", arguments: { value: "sibling" } });
      controller.abort(new DOMException("cancelled downstream", "AbortError"));

      await expect(longCall).rejects.toMatchObject({
        name: "SdkError",
        message: expect.stringContaining("cancelled downstream"),
      });
      await expect(sibling).resolves.toMatchObject({ structuredContent: { echo: "sibling" } });
      await expect(client.callTool({ name: "alpha", arguments: { value: "after" } }))
        .resolves.toMatchObject({ structuredContent: { echo: "after" } });
      expect(calls).toEqual(["long", "sibling", "after"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("releases a discarded probe mirror when its concrete server closes", async () => {
    const server = new McpServer({ name: "probe-lifecycle-test", version: "1.0.0" });
    const mirror = new AgentMcpToolMirror(server, async () => ({ content: [] }));
    const mirrors = new Set<AgentMcpToolMirror>();
    trackAgentMcpToolMirrorLifecycle(server, mirror, mirrors);
    expect(mirrors).toEqual(new Set([mirror]));

    const client = new Client(
      { name: "probe-lifecycle-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy", probe: { timeoutMs: 2_000 } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await server.close();
    expect(mirrors.size).toBe(0);
    await client.close().catch(() => undefined);
  });
});
