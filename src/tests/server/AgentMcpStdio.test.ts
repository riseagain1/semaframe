import {
  Client,
  type ProtocolEra,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const EXPECTED_TOOLS = [
  "begin_workspace_asset_import",
  "begin_workspace_photo_reconstruction",
  "begin_workspace_update",
  "cancel_workspace_asset_import",
  "cancel_workspace_photo_reconstruction",
  "complete_workspace_asset_import",
  "finalize_workspace_photo_reconstruction",
  "get_workspace_instructions",
  "inspect_workspace",
  "inspect_workspace_asset",
  "inspect_workspace_component",
  "inspect_workspace_model",
  "inspect_workspace_photo_reconstruction",
  "inspect_workspace_physics",
  "inspect_workspace_space",
  "query_spatial_placement",
  "query_stable_placement",
  "read_workspace_events",
  "read_workspace_resource_snapshot",
  "redo_workspace_batch",
  "simulate_workspace_physics",
  "start_workspace_photo_reconstruction",
  "submit_workspace_batch",
  "undo_workspace_batch",
];

type NegotiationSnapshot = {
  era: ProtocolEra | undefined;
  protocolVersion: string | undefined;
  discoverResult: ReturnType<Client["getDiscoverResult"]>;
  serverVersion: ReturnType<Client["getServerVersion"]>;
  toolNames: string[];
  allInputsClosed: boolean;
  allHaveOutputSchema: boolean;
  historyToolsRequireRevision: boolean;
};

function serverParameters(): StdioServerParameters {
  return {
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href,
      join(PROJECT_ROOT, "scripts", "agent-mcp.ts"),
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...getDefaultEnvironment(),
      // Tool discovery is local and does not contact the lazy upstream.
      SEMAFRAME_AGENT_MCP_URL: "http://127.0.0.1:9/mcp/stdio-negotiation-test",
    },
    stderr: "pipe",
  };
}

async function inspectNegotiation(mode: VersionNegotiationMode): Promise<NegotiationSnapshot> {
  const client = new Client(
    { name: "semaframe-negotiation-test", version: "1.0.0" },
    { versionNegotiation: { mode, probe: { timeoutMs: 5_000 } } },
  );
  const transport = new StdioClientTransport(serverParameters());
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const historyTools = tools.filter((tool) => ["undo_workspace_batch", "redo_workspace_batch"].includes(tool.name));
    return {
      era: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      discoverResult: client.getDiscoverResult(),
      serverVersion: client.getServerVersion(),
      toolNames: tools.map((tool) => tool.name).sort(),
      allInputsClosed: tools.every((tool) => tool.inputSchema.additionalProperties === false),
      allHaveOutputSchema: tools.every((tool) => Boolean(tool.outputSchema)),
      historyToolsRequireRevision: historyTools.length === 2 && historyTools.every((tool) => {
        const required = tool.inputSchema.required;
        return Array.isArray(required) && required.includes("expected_workspace_revision");
      }),
    };
  } catch (cause) {
    const diagnostic = stderr.trim();
    if (diagnostic) {
      throw new Error(`The Agent MCP child wrote to stderr:\n${diagnostic}`, { cause });
    }
    throw cause;
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe("Agent MCP stdio protocol negotiation", () => {
  it("serves a 2025-era client through the legacy initialize handshake", async () => {
    const result = await inspectNegotiation("legacy");

    expect(result.era).toBe("legacy");
    expect(result.protocolVersion).toMatch(/^2025-/u);
    expect(result.discoverResult).toBeUndefined();
    expect(result.serverVersion).toEqual({ name: "semaframe-workspace-engine", version: "1.9.0" });
    expect(result.toolNames).toEqual(EXPECTED_TOOLS);
    expect(result.allInputsClosed).toBe(true);
    expect(result.allHaveOutputSchema).toBe(true);
    expect(result.historyToolsRequireRevision).toBe(true);
  }, 15_000);

  it("serves a 2026-era client through mandatory modern discovery", async () => {
    const result = await inspectNegotiation({ pin: "2026-07-28" });

    expect(result.era).toBe("modern");
    expect(result.protocolVersion).toBe("2026-07-28");
    expect(result.discoverResult).toMatchObject({
      supportedVersions: ["2026-07-28"],
      resultType: "complete",
    });
    expect(result.serverVersion).toEqual({ name: "semaframe-workspace-engine", version: "1.9.0" });
    expect(result.toolNames).toEqual(EXPECTED_TOOLS);
    expect(result.allInputsClosed).toBe(true);
    expect(result.allHaveOutputSchema).toBe(true);
    expect(result.historyToolsRequireRevision).toBe(true);
  }, 15_000);
});
