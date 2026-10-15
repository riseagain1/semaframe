import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_AGENT_CORE_GUIDE,
  WORKSPACE_AGENT_GUIDE,
  WORKSPACE_AGENT_GUIDE_TOPICS,
  WORKSPACE_AGENT_OPERATION_SCHEMAS,
  WORKSPACE_LAYOUT_QUICKSTART,
  WORKSPACE_MODELING_QUICKSTART,
  WORKSPACE_DATA_INTERACTION_QUICKSTART,
  digestWorkspaceAgentValue,
  getWorkspaceAgentGuideDigest,
} from "../../workspace/agents/guide";
import type { JSONValue } from "../../workspace/agents/contracts";

function exampleIds(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(exampleIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exampleIds(item)]));
  }
  return typeof value === "string" && value.startsWith("<") ? "CMP_example" : value;
}

describe("Progressive Agent discovery guidance", () => {
  it("keeps the mandatory core small without stripping authority or safety boundaries", () => {
    const core = JSON.stringify(WORKSPACE_AGENT_CORE_GUIDE);
    expect(new TextEncoder().encode(core).byteLength).toBeLessThan(6_200);
    for (const rule of [
      "instruction_digest", "granted_scopes", "registry_digest", "parent-local",
      "query_spatial_placement", "query_layout_placement", "resize_component",
      "connect_event", "effect:data_read", "untrusted data", "identical",
      "omitted/truncated/projection-dependent", "another person's intervening edit",
      "view_graph", "current_view_valid null", "view_guard",
    ]) expect(core).toContain(rule);
    expect(WORKSPACE_AGENT_CORE_GUIDE).not.toHaveProperty("workspace_command_schema");
    expect([...WORKSPACE_AGENT_CORE_GUIDE.discovery.guide_topics].sort()).toEqual(Object.keys(WORKSPACE_AGENT_GUIDE_TOPICS).sort());
    expect(String((WORKSPACE_AGENT_GUIDE_TOPICS.physics as { instructions: string }).instructions)).toContain("stabilityMode enforce");
    expect(String((WORKSPACE_AGENT_GUIDE_TOPICS.xr as { instructions: string }).instructions)).toContain("sourceTimestampBasis");
  });

  it("binds the compact and full contract to one digest including all guidance", async () => {
    expect(await getWorkspaceAgentGuideDigest()).toBe(await digestWorkspaceAgentValue({
      full: WORKSPACE_AGENT_GUIDE,
      core: WORKSPACE_AGENT_CORE_GUIDE,
      topics: WORKSPACE_AGENT_GUIDE_TOPICS,
    }));
  });

  it("exports closed standalone operation schemas and schema-valid layout/interaction examples", () => {
    const validators = Object.fromEntries(Object.entries(WORKSPACE_AGENT_OPERATION_SCHEMAS).map(([name, schema]) => [
      name, addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(schema as object),
    ]));
    expect(Object.keys(validators)).toHaveLength(24);
    const layout = WORKSPACE_LAYOUT_QUICKSTART as { movement_and_resize: { operations: JSONValue[] } };
    const interactions = WORKSPACE_DATA_INTERACTION_QUICKSTART as { interactions: { operation: JSONValue }[] };
    for (const operation of [...layout.movement_and_resize.operations, ...interactions.interactions.map((entry) => entry.operation)]) {
      const concrete = exampleIds(operation) as Record<string, JSONValue>;
      const validate = validators[concrete.op as string]!;
      expect(validate(concrete), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...concrete, arbitrary_hidden_field: true })).toBe(false);
    }
  });

  it("teaches distinct existing/new candidate forms and prevents double translation", () => {
    const modeling = WORKSPACE_MODELING_QUICKSTART as {
      local_coordinate_example: {
        parent_root: { position: { x: number; y: number; z: number } };
        child_local: { position: { x: number; y: number; z: number } };
        child_composed_world: { position: { x: number; y: number; z: number } };
      };
      existing_assembly_preflight: { candidate: Record<string, unknown> };
    };
    const example = modeling.local_coordinate_example;
    for (const axis of ["x", "y", "z"] as const) {
      expect(example.parent_root.position[axis] + example.child_local.position[axis]).toBe(example.child_composed_world.position[axis]);
    }
    expect(Object.keys(modeling.existing_assembly_preflight.candidate).sort()).toEqual(["component_id", "placement"]);
    expect(JSON.stringify(WORKSPACE_LAYOUT_QUICKSTART)).toContain("NEW panel omit component_id and provide component_type");
    expect(JSON.stringify(WORKSPACE_MODELING_QUICKSTART)).toContain("full inverse parent transform");
  });

  it("requires explicit contact clearance and verifiable multipart roots, including nested objects", () => {
    const core = JSON.stringify(WORKSPACE_AGENT_CORE_GUIDE);
    const modeling = WORKSPACE_MODELING_QUICKSTART as {
      contact_and_clearance: { contact_collision_example: unknown; arithmetic_example: string };
      authoring: string[];
      completion_checklist: string[];
    };
    for (const text of ["margin 0.02m", "collision_evidence", "query AND commit", "lamp on a table", "parent_id", "preserve_world"]) {
      expect(core).toContain(text);
    }
    expect(modeling.contact_and_clearance.contact_collision_example).toEqual({
      enabled: true, role: "solid", shape: "asset_bounds", margin: 0,
    });
    const instructions = JSON.stringify(modeling);
    for (const text of ["safety_margin_only", "collider_penetration", "not exact mesh", "static bodies", "Keep existing collider centers"]) {
      expect(instructions).toContain(text);
    }
    expect(modeling.authoring.join(" ")).toContain("OWN model-assembly root");
    expect(modeling.authoring.join(" ")).toContain("even if the table already has an assembly");
    for (const text of ["roots AND all parts", "actual root type", "child IDs", "requested part count", "parent_id", "preserve_world", "unchanged world transforms"]) {
      expect(modeling.completion_checklist.join(" ")).toContain(text);
    }
  });
});
