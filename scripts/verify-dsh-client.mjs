#!/usr/bin/env node

// Opt-in interoperability verification. The caller must install the exact
// official client separately. No downloads, credentials, model calls, user
// settings, existing listeners, or persistent project files are used here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { createDshMcpPatch } from "./lib/dsh-setup.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = process.env.SEMAFRAME_DSH_RUNTIME_ROOT;
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error("Set SEMAFRAME_DSH_RUNTIME_ROOT to an absolute, isolated npm prefix containing @deepseek-ai/dsh-mcp-client@0.2.0-rc.2. This verifier never downloads packages.");
}
const runtimeRequire = createRequire(join(runtimeRoot, "package.json"));
const clientPackage = runtimeRequire.resolve("@deepseek-ai/dsh-mcp-client/package.json");
const metadata = JSON.parse(readFileSync(clientPackage, "utf8"));
assert.equal(metadata.version, "0.2.0-rc.2", "Install the version bundled by the tested DSH CLI, not the MCP package's potentially stale latest tag.");
const loadOfficial = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const [{ Context }, { ToolRuntime }, { SystemPrompt }, officialMcp, { startDshGatewayFixture }] = await Promise.all([
  loadOfficial("@deepseek-ai/cordis"),
  loadOfficial("@deepseek-ai/dsh-tools"),
  loadOfficial("@deepseek-ai/dsh-system-prompt"),
  loadOfficial("@deepseek-ai/dsh-mcp-client"),
  tsImport("./fixtures/dsh-gateway.ts", import.meta.url),
]);

function canonicalData(result) {
  assert.equal(result.isError, false, "The official DSH runtime unexpectedly rejected a valid SemaFrame call.");
  assert.equal(result.value.structuredContent.ok, true);
  const wireText = result.value.content.find((block) => block.type === "text").text;
  assert.deepEqual(JSON.parse(wireText), result.value.structuredContent);
  // DSH adds a resource-link description after the untouched JSON text.
  assert(result.content[0].text.startsWith(wireText));
  return result.value.structuredContent.data;
}

function failurePayload(result) {
  assert.equal(result.isError, true, "An upstream MCP failure must not become success.");
  const text = result.content.map((block) => block.text ?? "").join("\n");
  const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.equal(payload.ok, false);
  return payload.error;
}

const fixture = await startDshGatewayFixture(repositoryRoot);
const ctx = new Context();
try {
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx, { mode: "native" });
  const overlay = JSON.parse(createDshMcpPatch(fixture.mcpConfig));
  assert.equal(overlay[0].insert[0].name, "@deepseek-ai/dsh-mcp-client");
  const config = officialMcp.Config(overlay[0].insert[0].config);
  assert.equal(config.env.SEMAFRAME_AGENT_NAME, "DeepSeek Harness");
  assert.equal(config.env.SEMAFRAME_AGENT_GATEWAY_URL, fixture.origin);
  assert.equal(config.toolCallTimeoutMs, 60_000);
  // Execute the exact generated command, argv, and env against the isolated
  // production Gateway. No replacement stdio server or monkeypatched client.
  await officialMcp.apply(ctx, config);
  const initialSchemas = ctx.tools.schemas();
  assert(Buffer.byteLength(JSON.stringify(initialSchemas)) < 80_000, "Progressive discovery must keep the real DSH tool catalog compact.");
  assert.equal(initialSchemas.length, 27);
  assert(initialSchemas.some(({ name }) => name === "mcp__semaframe__inspect_workspace_capabilities"));
  assert(initialSchemas.some(({ name }) => name === "mcp__semaframe__analyze_workspace_precision"));
  assert(initialSchemas.every(({ name }) => name.length <= 64));
  let sequence = 0;
  const run = (rawName, args) => ctx.tools.execute({
    callId: `dsh-validation-${++sequence}`,
    name: `mcp__semaframe__${rawName}`,
    arguments: args,
    signal: AbortSignal.timeout(15_000),
  });
  const identity = { client_id: "dsh-official-client-test", client_name: "DeepSeek Harness validation" };
  const pending = failurePayload(await run("get_workspace_instructions", identity));
  assert.equal(pending.code, "approval_pending");
  assert.equal(fixture.dispatchedCommands(), 0, "Approval must gate access to the test workspace.");
  fixture.advanceClock(15_000);
  // Approval is given ONLY to this newly-created in-memory fixture.
  fixture.approveFixtureClaim(pending.details.claim_id);
  // The real official client must redeem successfully after BOTH the original
  // pending claim and original offer deadlines, within the approved window.
  fixture.advanceClock(70_000);
  const guide = canonicalData(await run("get_workspace_instructions", {
    ...identity, approval_token: pending.details.approval_token,
  }));
  assert.equal(guide.guide_detail, "core");
  assert.equal(guide.guide.detail, "core");
  assert(Buffer.byteLength(JSON.stringify(guide.guide)) < 6_200);
  assert(!guide.guide.workspace_command_schema);
  const session = { session_token: guide.session_token, instruction_digest: guide.guide_digest };
  const inspected = canonicalData(await run("inspect_workspace", session));
  assert.equal(inspected.workspace_revision, 0);
  assert.equal(inspected.capability_manifest.detail, "catalog");
  assert.equal(inspected.capability_manifest.schemas_included, false);
  const discovery = canonicalData(await run("inspect_workspace_capabilities", {
    ...session, component_type_ids: ["stage-3d"], guide_topics: ["creation"], operation_names: ["create_component"],
  }));
  assert.equal(discovery.registry_digest, inspected.registry_digest);
  assert(discovery.component_types[0].propsSchema);
  assert(discovery.guide_topics.creation);
  assert(discovery.operation_schemas.create_component);
  const invalid = failurePayload(await run("inspect_workspace", {
    ...session, instruction_digest: "not-the-real-guide-digest",
  }));
  assert.equal(invalid.code, "instruction_digest_mismatch");
  assert.equal(canonicalData(await run("inspect_workspace", session)).workspace_revision, 0);
  const prepared = canonicalData(await run("begin_workspace_update", {
    ...session, intent: "Isolated official DSH fixture operation", requested_component_ids: 1,
  }));
  const capability = prepared.capability_manifest.component_types.find(({ typeId }) => typeId === "stage-3d");
  assert(capability);
  assert.equal(prepared.capability_manifest.detail, "catalog");
  assert.equal(capability.digest, discovery.component_types[0].digest);
  assert(Buffer.byteLength(JSON.stringify(prepared)) < 15_000);
  const receipt = canonicalData(await run("submit_workspace_batch", {
    ...session,
    transaction_token: prepared.transaction_token,
    batch: { ...prepared.envelope, operations: [{
      op: "create_component", op_id: "dsh-create-stage", id: prepared.reserved_component_ids[0],
      component_type: { typeId: capability.typeId, version: capability.version, digest: capability.digest },
      placement: {
        space: "world3d", position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
    }] },
  }));
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.resulting_workspace_revision, 1);
  assert.equal(canonicalData(await run("inspect_workspace", session)).workspace_revision, 1);
  const scenePreparation = canonicalData(await run("begin_workspace_update", {
    ...session, intent: "Populate real spatial, layout and runtime view graphs", requested_component_ids: 2,
  }));
  assert.equal(scenePreparation.layout_frame, "current_view");
  assert.equal(scenePreparation.view_guard.view_id, "isolated-dsh-fixture-view");
  assert.equal(scenePreparation.view_guard.view_epoch, 1);
  assert(!Object.hasOwn(scenePreparation.envelope, "view_guard"));
  assert(!Object.hasOwn(scenePreparation.envelope, "layout_frame"));
  const binding = (typeId) => {
    const type = scenePreparation.capability_manifest.component_types.find((entry) => entry.typeId === typeId);
    assert(type, `Missing fixture component type ${typeId}`);
    return { typeId: type.typeId, version: type.version, digest: type.digest };
  };
  const [boxId, buttonId] = scenePreparation.reserved_component_ids;
  canonicalData(await run("submit_workspace_batch", {
    ...session,
    transaction_token: scenePreparation.transaction_token,
    batch: { ...scenePreparation.envelope, operations: [
      {
        op: "create_component", op_id: "fixture-box", id: boxId,
        component_type: binding("spatial-primitive"),
        placement: { space: "world3d", position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      },
      {
        op: "create_component", op_id: "fixture-button", id: buttonId,
        component_type: binding("button"),
        placement: { space: "viewport", anchor: "top_left", offset: { x: 16, y: 100 }, size: { width: 160, height: 48 } },
      },
    ] },
  }));
  // This must pass through the actual DSH ToolRuntime, not a mocked response.
  // canonicalData asserts its model-visible JSON matches structuredContent.
  const space = canonicalData(await run("inspect_workspace_space", { ...session, view_detail: "full" }));
  assert.equal(space.workspace_revision, 2);
  assert(space.spatial_graph.nodes.some((node) => node.id === boxId), "A real nonempty 3D graph must reach the model.");
  assert(space.layout_graph.nodes.some((node) => node.id === buttonId), "A real nonempty canonical layout graph must reach the model.");
  assert.equal(space.view_graph.status, "ready");
  assert.equal(space.view_graph.ephemeral, true);
  assert(space.view_graph.nodes.some((node) => node.component_id === buttonId), "A real nonempty runtime view graph must reach the model.");
  const compactSpace = canonicalData(await run("inspect_workspace_space", session));
  assert.equal(compactSpace.view_graph.node_count, space.view_graph.nodes.length);
  assert.equal(compactSpace.view_graph.nodes, undefined, "Runtime node detail must remain opt-in.");
  const synchronizedSchemas = ctx.tools.schemas();
  assert.equal(synchronizedSchemas.length, 37, "DSH must synchronize the upstream host-control catalog.");
  assert(synchronizedSchemas.some(({ name }) => name === "mcp__semaframe__get_live_xr_context"));
  console.log(JSON.stringify({
    officialPlugin: `${metadata.name}@${metadata.version}`,
    actualCordisAndToolRuntime: true,
    exactGeneratedBridgeCommand: true,
    initialTools: initialSchemas.length,
    synchronizedTools: synchronizedSchemas.length,
    explicitFixtureApprovalRoundTrip: true,
    approvedHandshakeSurvivesOriginalDeadlines: true,
    guideBytes: Buffer.byteLength(JSON.stringify(guide.guide)),
    discoveryBytes: Buffer.byteLength(JSON.stringify(discovery)),
    preparationBytes: Buffer.byteLength(JSON.stringify(prepared)),
    initialToolCatalogBytes: Buffer.byteLength(JSON.stringify(initialSchemas)),
    progressiveDiscoveryWithExactBindings: true,
    structuredContentAndModelTextPreserved: true,
    nonemptySpatialLayoutAndRuntimeGraphsPreserved: true,
    runtimeViewSummaryAndFullVerified: true,
    errorNotFalseSuccess: true,
    sameSessionRecovery: true,
    memoryOnlyWorkspaceMutation: "committed",
    finalWorkspaceRevision: 2,
    liveWorkspaceTouched: false,
    modelApiCalls: 0,
  }, null, 2));
} finally {
  try { await ctx.fiber.dispose(); } finally { await fixture.close(); }
}
