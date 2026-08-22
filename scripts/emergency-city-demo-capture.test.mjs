import assert from "node:assert/strict";
import test from "node:test";

import {
  issueApprovedAgentSession,
  summarizeEmergencyCityValidation,
} from "./emergency-city-demo-capture.mjs";

function fakeClient(payload) {
  return {
    async callTool(request) {
      assert.equal(request.name, "get_workspace_instructions");
      assert.equal(request.arguments.approval_token, "approval_private");
      return { structuredContent: payload };
    },
  };
}

const request = {
  identity: {
    client_id: "capture-test",
    client_name: "Capture test",
    requested_scopes: ["workspace:read", "effect:data_read"],
  },
  approvalToken: "approval_private",
  label: "Capture test Agent",
};

test("approved offers can issue a fresh bounded session without returning the approval credential", async () => {
  const result = await issueApprovedAgentSession(fakeClient({
    ok: true,
    data: {
      session_token: "workspace_session_fresh",
      session_expires_at: "2099-01-01T00:30:00.000Z",
      guide_digest: "sha256:guide",
      granted_scopes: ["workspace:read", "effect:data_read"],
    },
  }), request);

  assert.deepEqual(result, {
    session: {
      session_token: "workspace_session_fresh",
      instruction_digest: "sha256:guide",
    },
    sessionExpiresAt: "2099-01-01T00:30:00.000Z",
    grantedScopes: ["workspace:read", "effect:data_read"],
  });
  assert.equal(JSON.stringify(result).includes("approval_private"), false);
});

test("session issue fails closed for expired or malformed instruction responses", async () => {
  await assert.rejects(
    issueApprovedAgentSession(fakeClient({
      ok: true,
      data: {
        session_token: "workspace_session_expired",
        session_expires_at: "2000-01-01T00:00:00.000Z",
        guide_digest: "sha256:guide",
        granted_scopes: ["workspace:read"],
      },
    }), request),
    /handshake failed/u,
  );
  await assert.rejects(
    issueApprovedAgentSession(fakeClient({ ok: false, error: { code: "approval_invalid" } }), request),
    /approval_invalid/u,
  );
});

test("emergency-city validation reads the MCP physics body's snake-case protocol fields", () => {
  const bodies = Array.from({ length: 12 }, (_, index) => ({
    component_id: `CMP_${index}`,
    enabled: true,
    body_type: index < 10 ? "kinematic" : "static",
    stable: true,
    grounded: true,
    stability_reason: index < 10 ? "driven" : "anchored",
  }));
  const result = summarizeEmergencyCityValidation(
    {
      ok: true,
      data: { spatial_graph: { collision_conflicts: [] } },
    },
    {
      ok: true,
      data: {
        physics_validation: {
          version: "2.0",
          model: "quasi_static_rigid_support_v2",
          feasible: true,
          issues: [],
          bodies,
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.enabledBodyCount, 12);
  assert.equal(result.diagnostics.kinematicBodyCount, 10);
  assert.equal(result.diagnostics.enabledBodies[0].bodyType, "kinematic");
});

test("emergency-city validation reports every failing spatial and physics invariant", () => {
  const result = summarizeEmergencyCityValidation(
    {
      ok: true,
      data: { spatial_graph: { collision_conflicts: [{ left_id: "A", right_id: "B" }] } },
    },
    {
      ok: true,
      data: {
        physics_validation: {
          feasible: false,
          issues: [{ code: "unsupported", component_id: "FLOAT" }],
          bodies: [{ component_id: "STATIC", enabled: true, body_type: "static" }],
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.reasons, [
    "collision_conflicts_present",
    "physics_not_feasible",
    "kinematic_vehicle_count_not_10",
  ]);
  assert.equal(result.diagnostics.collisionConflictCount, 1);
  assert.equal(result.diagnostics.physicsIssues[0].component_id, "FLOAT");
});
