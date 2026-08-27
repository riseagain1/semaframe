// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";
import {
  SEMAFRAME_EXCHANGE_FORMAT,
  SEMAFRAME_EXCHANGE_VERSION,
  bridgeJsonBytes,
  type SemaFrameExchangeManifest,
} from "../../bridge";
import { createDeterministicCadHandoffArchive } from "../../workspace/modeling/cadHandoffArchive";

const ORIGIN = "http://127.0.0.1:4173";
const PUBLIC_URL = "http://127.0.0.1:8788";
const BOOTSTRAP = "b".repeat(43);

function manifest(): SemaFrameExchangeManifest {
  return {
    format: SEMAFRAME_EXCHANGE_FORMAT,
    version: SEMAFRAME_EXCHANGE_VERSION,
    generator: { name: "SemaFrame", version: "test" },
    source: {
      workspaceId: "WORKSPACE",
      revision: 3,
      workspaceDigest: `sha256:${"0".repeat(64)}`,
      registryDigest: "fnv1a32:11111111",
    },
    coordinateSystem: { units: "metre", handedness: "right", upAxis: "Y", angles: "radian" },
    nodes: [],
    resources: [],
    connections: [],
    files: [],
    roundTrip: { stableIds: true, directMutation: false, editsReturnAs: "reviewable_change_proposal" },
  };
}

function createRequest(csrf: string, overrides: Readonly<{ origin?: string; bootstrap?: string }> = {}): Request {
  const exchangeManifest = manifest();
  const archive = createDeterministicCadHandoffArchive([{
    path: "semaframe.exchange.json",
    bytes: bridgeJsonBytes(exchangeManifest),
  }]);
  const metadata = JSON.stringify({
    target: "blender",
    sequence: 1,
    workspaceId: exchangeManifest.source.workspaceId,
    revision: exchangeManifest.source.revision,
    exchangeDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    manifest: exchangeManifest,
    ttlMs: 10_000,
  });
  const boundary = "semaframe-gateway-test";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="scene.semaframe-exchange"\r\n`
    + "Content-Type: application/vnd.semaframe.exchange+zip\r\n\r\n",
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.byteLength + archive.byteLength + suffix.byteLength);
  body.set(prefix);
  body.set(archive, prefix.byteLength);
  body.set(suffix, prefix.byteLength + archive.byteLength);
  return new Request(`${PUBLIC_URL}/api/agent/bridge/sessions`, {
    method: "POST",
    headers: {
      origin: overrides.origin ?? ORIGIN,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-semaframe-agent-csrf": csrf,
      "x-semaframe-browser-bootstrap": overrides.bootstrap ?? BOOTSTRAP,
    },
    body: body.buffer,
  });
}

describe("Agent Gateway Scene Bridge integration", () => {
  it("keeps owner and native capabilities separate and revokes sessions on shutdown", async () => {
    const gateway = new AgentGateway({
      publicBaseUrl: PUBLIC_URL,
      workspaceRoot: "/workspace/SemaFrame",
      commandTimeoutMs: 1_000,
      pollTimeoutMs: 1_000,
      browserTtlMs: 5_000,
    });
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: [ORIGIN],
      publicBaseUrl: PUBLIC_URL,
      browserBootstrapToken: BOOTSTRAP,
    });
    try {
      const configResponse = await handle(new Request(`${PUBLIC_URL}/api/agent/config`, {
        headers: { origin: ORIGIN, "x-semaframe-browser-bootstrap": BOOTSTRAP },
      }));
      const config = await configResponse.json() as Record<string, unknown>;
      const csrf = String(config.csrfToken);

      expect((await handle(createRequest(csrf, { bootstrap: "c".repeat(43) }))).status).toBe(403);
      expect((await handle(createRequest(csrf, { origin: "https://attacker.example" }))).status).toBe(403);

      const created = await handle(createRequest(csrf));
      expect(created.status).toBe(201);
      const access = await created.json() as Record<string, string>;
      expect(access.pullUrl).not.toContain(access.bearer);

      const pulled = await handle(new Request(access.pullUrl, {
        headers: { authorization: `Bearer ${access.bearer}` },
      }));
      expect(pulled.status).toBe(200);
      expect(await pulled.json()).toMatchObject({ ok: true, data: { target: "blender" } });

      const broadCommand = await handle(new Request(`${PUBLIC_URL}/v1/workspace/instructions`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.bearer}`, "content-type": "application/json" },
        body: "{}",
      }));
      expect(broadCommand.status).toBe(401);

      await handle.close();
      const revoked = await handle(new Request(access.pullUrl, {
        headers: { authorization: `Bearer ${access.bearer}` },
      }));
      expect(revoked.status).toBe(404);
    } finally {
      await handle.close().catch(() => undefined);
      gateway.close();
    }
  });
});
