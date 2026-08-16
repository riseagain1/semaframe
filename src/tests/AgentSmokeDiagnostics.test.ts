// @vitest-environment node
import { describe, expect, it } from "vitest";
// The smoke runner is intentionally executable JavaScript; importing it is
// safe because its main routine is guarded by import.meta.url.
// @ts-expect-error The executable .mjs file does not ship a declaration file.
import * as agentSmokeDiagnostics from "../../scripts/agent-smoke.mjs";

const {
  redactAgentSmokeDiagnosticText,
  sanitizeAgentSmokeFailure,
  stringifyAgentSmokeDiagnostic,
} = agentSmokeDiagnostics;

const capabilities = {
  approval: "approval-capability-example",
  session: "session-capability-example",
  transaction: "transaction-capability-example",
  guide: "sha256:guide-capability-example",
  offer: "offer-capability-example",
};
const sensitiveValues = Object.values(capabilities);

describe("Agent smoke diagnostic redaction", () => {
  it("redacts structured Workspace capabilities while retaining useful fields", () => {
    const diagnostic = stringifyAgentSmokeDiagnostic({
      ok: false,
      error: { code: "unexpected_handshake", message: `session failed: ${capabilities.session}` },
      data: {
        approval_token: capabilities.approval,
        sessionToken: capabilities.session,
        transaction_token: capabilities.transaction,
        guide_digest: capabilities.guide,
        component_type: { typeId: "timer", digest: "public-component-digest" },
      },
    }, sensitiveValues);

    for (const capability of sensitiveValues) expect(diagnostic).not.toContain(capability);
    expect(diagnostic).toContain('"code":"unexpected_handshake"');
    expect(diagnostic).toContain('"typeId":"timer"');
    expect(diagnostic).toContain('"digest":"public-component-digest"');
    expect(diagnostic.match(/\[redacted\]/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it("sanitizes the final thrown Error, including keyed text, bearer values, and offer URLs", () => {
    const unsafe = new Error([
      `approval_token=${capabilities.approval}`,
      `session_token: ${capabilities.session}`,
      `transaction_token=${capabilities.transaction}`,
      `guide_digest=${capabilities.guide}`,
      "Authorization: Bearer bearer-capability-example",
      `http://127.0.0.1:8788/mcp/connect/${capabilities.offer}`,
    ].join(" | "));

    const safe = sanitizeAgentSmokeFailure(unsafe, sensitiveValues);
    const rendered = `${safe.message}\n${safe.stack ?? ""}`;
    for (const capability of [...sensitiveValues, "bearer-capability-example"]) {
      expect(rendered).not.toContain(capability);
    }
    expect(rendered).not.toContain(unsafe.message);
    expect(safe.message).toContain("[redacted]");
    expect(safe.message).toContain("/mcp/connect/[redacted]");
  });

  it("redacts secrets embedded in otherwise unstructured process output", () => {
    const output = redactAgentSmokeDiagnosticText(
      `gateway rejected ${capabilities.transaction}; instruction_digest=sha256:unregistered-secret`,
      sensitiveValues,
    );
    expect(output).not.toContain(capabilities.transaction);
    expect(output).not.toContain("sha256:unregistered-secret");
    expect(output).toContain("gateway rejected [redacted]");
  });
});
