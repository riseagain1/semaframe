import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAssetIngress } from "../../../server/agent/AgentAssetIngress";
import { AgentGateway } from "../../../server/agent/AgentGateway";
import { createAgentGatewayHttpHandler } from "../../../server/agent/AgentGatewayHttpHandler";
import type { PhotoReconstructionService } from "../../../server/reconstruction/PhotoReconstructionService";

const gateways: AgentGateway[] = [];

afterEach(() => {
  gateways.splice(0).forEach((gateway) => gateway.close());
});

describe("Agent Gateway shutdown", () => {
  it("closes AssetIngress even when photo cleanup reports a failure", async () => {
    const gateway = new AgentGateway({
      publicBaseUrl: "http://127.0.0.1:8788",
      workspaceRoot: "/workspace/SemaFrame",
    });
    gateways.push(gateway);
    const assetIngress = new AgentAssetIngress({
      publicBaseUrl: "http://127.0.0.1:8788",
      sweepIntervalMs: 0,
    });
    const assetClose = vi.spyOn(assetIngress, "close").mockResolvedValue();
    const cleanupFailure = new Error("injected photo cleanup failure");
    const photoReconstruction = {
      close: vi.fn(async () => { throw cleanupFailure; }),
    } as unknown as PhotoReconstructionService;
    const handle = createAgentGatewayHttpHandler(gateway, {
      allowedOrigins: ["http://127.0.0.1:4173"],
      publicBaseUrl: "http://127.0.0.1:8788",
      browserBootstrapToken: "b".repeat(43),
      assetIngress,
      photoReconstruction,
    });

    await expect(handle.close()).rejects.toBe(cleanupFailure);
    expect(assetClose).toHaveBeenCalledOnce();
  });
});
