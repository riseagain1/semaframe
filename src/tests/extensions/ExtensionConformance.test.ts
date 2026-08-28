import { describe, expect, it } from "vitest";
import {
  EXAMPLE_JSON_EXPORTER_PROVIDER_V1,
  EXAMPLE_EXTENSION_MANIFEST_V1,
  NOOP_CONNECTOR_PROVIDER_V1,
  runConnectorProviderConformanceV1,
  runExporterProviderConformanceV1,
  type ConnectorProviderV1,
  type ExporterProviderV1,
} from "../../extensions";
import { SEMAFRAME_VERSION } from "../../version";

describe("Extension provider conformance", () => {
  it("passes the no-op connector and deterministic JSON exporter", async () => {
    expect(EXAMPLE_EXTENSION_MANIFEST_V1.compatibility.minimumHostVersion).toBe(SEMAFRAME_VERSION);
    await expect(runConnectorProviderConformanceV1({
      provider: NOOP_CONNECTOR_PROVIDER_V1,
    })).resolves.toMatchObject({ passed: true, providerKind: "connector" });
    await expect(runExporterProviderConformanceV1({
      provider: EXAMPLE_JSON_EXPORTER_PROVIDER_V1,
    })).resolves.toMatchObject({ passed: true, providerKind: "exporter" });
  });

  it("reports malformed provider output without trusting it", async () => {
    const connector: ConnectorProviderV1 = {
      kind: "connector",
      id: "bad.connector",
      async probe() { return { available: true }; },
      async read() {
        return {
          items: [],
          observedAt: "not-a-time",
          source: { sourceId: "bad.connector" },
        };
      },
    };
    const connectorReport = await runConnectorProviderConformanceV1({ provider: connector });
    expect(connectorReport.passed).toBe(false);
    expect(connectorReport.cases.find((entry) => entry.name === "read contract"))
      .toMatchObject({ passed: false });

    const exporter: ExporterProviderV1 = {
      kind: "exporter",
      id: "bad.exporter",
      async plan() { return { formatId: "json", artifactNames: ["../escape.json"] }; },
      async export() {
        return [{ fileName: "../escape.json", mediaType: "application/json", bytes: new Uint8Array() }];
      },
    };
    const exporterReport = await runExporterProviderConformanceV1({ provider: exporter });
    expect(exporterReport.passed).toBe(false);
    expect(exporterReport.cases.filter((entry) => !entry.passed).map((entry) => entry.name))
      .toEqual(expect.arrayContaining(["plan contract", "export contract"]));
  });
});
