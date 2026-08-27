import { createHash } from "node:crypto";
import {
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";

const DEFAULT_MAXIMUM_TOOLS = 128;
const DEFAULT_MAXIMUM_CATALOG_BYTES = 8 * 1024 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class AgentMcpToolMirrorError extends Error {
  constructor(
    readonly code: "catalog_invalid" | "catalog_too_large" | "tool_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AgentMcpToolMirrorError";
  }
}

export type AgentMcpToolMirrorOptions = Readonly<{
  maximumTools?: number;
  maximumCatalogBytes?: number;
}>;

export type AgentMcpToolMirrorSyncResult = Readonly<{
  changed: boolean;
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
  digest: `sha256:${string}`;
}>;

type MirroredRegistration = {
  handle: RegisteredTool;
  fingerprint?: string;
};

type PreparedTool = Readonly<{
  tool: Tool;
  fingerprint: string;
  inputSchema: ReturnType<typeof fromJsonSchema>;
  outputSchema?: ReturnType<typeof fromJsonSchema>;
  callback: (input: unknown, context: ServerContext) => Promise<CallToolResult>;
}>;

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new AgentMcpToolMirrorError("catalog_invalid", "The upstream MCP tool catalog is not valid JSON data.");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function annotations(value: Tool["annotations"]): ToolAnnotations | undefined {
  if (!value) return undefined;
  return Object.freeze({
    ...(boundedText(value.title, 160) ? { title: boundedText(value.title, 160) } : {}),
    ...(typeof value.readOnlyHint === "boolean" ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === "boolean" ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === "boolean" ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === "boolean" ? { openWorldHint: value.openWorldHint } : {}),
  });
}

function schema(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMcpToolMirrorError("tool_invalid", `${label} must be a JSON Schema object.`);
  }
  try {
    return fromJsonSchema(value as JsonSchemaType);
  } catch {
    throw new AgentMcpToolMirrorError("tool_invalid", `${label} is not a supported JSON Schema.`);
  }
}

function normalizedTool(tool: Tool): Tool {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new AgentMcpToolMirrorError("tool_invalid", "A mirrored MCP tool name is invalid.");
  }
  return Object.freeze({
    name: tool.name,
    ...(boundedText(tool.title, 160) ? { title: boundedText(tool.title, 160) } : {}),
    ...(boundedText(tool.description, 16_000) ? { description: boundedText(tool.description, 16_000) } : {}),
    inputSchema: canonical(tool.inputSchema) as Tool["inputSchema"],
    ...(tool.outputSchema
      ? { outputSchema: canonical(tool.outputSchema) as NonNullable<Tool["outputSchema"]> }
      : {}),
    ...(annotations(tool.annotations) ? { annotations: annotations(tool.annotations) } : {}),
  });
}

/**
 * Keeps one long-lived stdio server's advertised tools aligned with the
 * currently discovered SemaFrame gateway. The gateway is still the only
 * execution authority; this class mirrors bounded public schemas and forwards
 * calls without retaining approval or Workspace capabilities.
 */
export class AgentMcpToolMirror {
  readonly #server: McpServer;
  readonly #callTool: (
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<CallToolResult>;
  readonly #maximumTools: number;
  readonly #maximumCatalogBytes: number;
  readonly #registrations = new Map<string, MirroredRegistration>();

  constructor(
    server: McpServer,
    callTool: (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<CallToolResult>,
    options: AgentMcpToolMirrorOptions = {},
  ) {
    this.#server = server;
    this.#callTool = callTool;
    this.#maximumTools = options.maximumTools ?? DEFAULT_MAXIMUM_TOOLS;
    this.#maximumCatalogBytes = options.maximumCatalogBytes ?? DEFAULT_MAXIMUM_CATALOG_BYTES;
    if (!Number.isSafeInteger(this.#maximumTools) || this.#maximumTools < 1) {
      throw new RangeError("maximumTools must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.#maximumCatalogBytes) || this.#maximumCatalogBytes < 1024) {
      throw new RangeError("maximumCatalogBytes must be a safe integer of at least 1024.");
    }
  }

  seed(name: string, handle: RegisteredTool): void {
    if (!TOOL_NAME_PATTERN.test(name) || this.#registrations.has(name)) {
      throw new AgentMcpToolMirrorError("tool_invalid", "A seeded MCP tool registration is invalid or duplicated.");
    }
    this.#registrations.set(name, { handle });
  }

  synchronize(untrustedTools: readonly Tool[]): AgentMcpToolMirrorSyncResult {
    if (!Array.isArray(untrustedTools) || untrustedTools.length > this.#maximumTools) {
      throw new AgentMcpToolMirrorError("catalog_invalid", "The upstream MCP tool catalog exceeds its bounded tool count.");
    }
    if (jsonBytes(untrustedTools) > this.#maximumCatalogBytes) {
      throw new AgentMcpToolMirrorError("catalog_too_large", "The upstream MCP tool catalog exceeds its byte limit.");
    }

    const tools = untrustedTools.map(normalizedTool).sort((left, right) => left.name.localeCompare(right.name));
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        throw new AgentMcpToolMirrorError("catalog_invalid", "The upstream MCP tool catalog contains duplicate names.");
      }
      names.add(tool.name);
    }

    // Convert and validate the complete untrusted catalog before touching any
    // live registration. A bad schema late in the list must not leave a
    // partially mirrored toolset behind.
    const prepared: PreparedTool[] = tools.map((tool) => Object.freeze({
      tool,
      fingerprint: digest(tool),
      inputSchema: schema(tool.inputSchema, `${tool.name}.inputSchema`),
      ...(tool.outputSchema
        ? { outputSchema: schema(tool.outputSchema, `${tool.name}.outputSchema`) }
        : {}),
      callback: async (input: unknown, context: ServerContext): Promise<CallToolResult> =>
        this.#callTool(
          tool.name,
          input && typeof input === "object" && !Array.isArray(input)
            ? input as Record<string, unknown>
            : {},
          context.mcpReq.signal,
        ),
    }));

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const entry of prepared) {
      const { tool, fingerprint, inputSchema, outputSchema, callback } = entry;
      const existing = this.#registrations.get(tool.name);
      if (!existing) {
        const handle = this.#server.registerTool(
          tool.name,
          {
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          },
          callback,
        );
        this.#registrations.set(tool.name, { handle, fingerprint });
        added.push(tool.name);
      } else if (existing.fingerprint !== fingerprint) {
        // RegisteredTool.update deliberately treats undefined as "unchanged".
        // Clear removed optional fields on the live registration first, then
        // use one update notification for the schemas/callback. This avoids a
        // remove/re-add notification race in downstream MCP client caches.
        existing.handle.title = tool.title;
        existing.handle.description = tool.description;
        existing.handle.annotations = tool.annotations;
        if (!outputSchema) {
          existing.handle.outputSchema = undefined;
          existing.handle.outputSchemaJson = undefined;
        }
        existing.handle.update({
          paramsSchema: inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          callback,
          enabled: true,
        });
        existing.fingerprint = fingerprint;
        updated.push(tool.name);
      }
    }

    for (const [name, registration] of [...this.#registrations]) {
      if (names.has(name)) continue;
      registration.handle.remove();
      this.#registrations.delete(name);
      removed.push(name);
    }

    return Object.freeze({
      changed: added.length + updated.length + removed.length > 0,
      added: Object.freeze(added),
      updated: Object.freeze(updated),
      removed: Object.freeze(removed),
      digest: digest(tools),
    });
  }
}

/**
 * Retains a mirror only for the lifetime of its concrete MCP server instance.
 * `serveStdio` may construct an optimistic modern probe and later discard it
 * before pinning a fresh legacy instance; the probe must not remain a catalog
 * synchronization target after its transport closes.
 */
export function trackAgentMcpToolMirrorLifecycle(
  server: McpServer,
  mirror: AgentMcpToolMirror,
  mirrors: Set<AgentMcpToolMirror>,
): void {
  mirrors.add(mirror);
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    mirrors.delete(mirror);
    previousOnClose?.();
  };
}
