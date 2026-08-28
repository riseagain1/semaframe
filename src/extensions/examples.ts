import { canonicalizeExtensionJson } from "./canonicalJson";
import type {
  ConnectorProviderV1,
  ExporterProviderV1,
  ExtensionProviderV1,
} from "./contracts";
import { parseExtensionManifestV1 } from "./manifest";

export const NOOP_CONNECTOR_PROVIDER_V1: ConnectorProviderV1 = Object.freeze({
  kind: "connector",
  id: "noop.connector",
  async probe() {
    return Object.freeze({ available: true });
  },
  async read() {
    return Object.freeze({
      items: Object.freeze([]),
      observedAt: "1970-01-01T00:00:00.000Z",
      source: Object.freeze({ sourceId: "noop.connector" }),
    });
  },
});

export const EXAMPLE_JSON_EXPORTER_PROVIDER_V1: ExporterProviderV1 = Object.freeze({
  kind: "exporter",
  id: "example.json.exporter",
  async plan() {
    return Object.freeze({
      formatId: "json",
      artifactNames: Object.freeze(["workspace.json"]),
    });
  },
  async export(request) {
    const bytes = new TextEncoder().encode(`${canonicalizeExtensionJson(request.workspaceSnapshot)}\n`);
    return Object.freeze([
      Object.freeze({ fileName: "workspace.json", mediaType: "application/json", bytes }),
    ]);
  },
});

export const EXAMPLE_EXTENSION_PROVIDERS_V1: readonly ExtensionProviderV1[] = Object.freeze([
  NOOP_CONNECTOR_PROVIDER_V1,
  EXAMPLE_JSON_EXPORTER_PROVIDER_V1,
]);

/** Manifest for the in-process examples. The package payload is the empty byte sequence. */
export const EXAMPLE_EXTENSION_MANIFEST_V1 = parseExtensionManifestV1({
  schemaVersion: "1.0",
  apiVersion: "1.0",
  id: "semaframe.example",
  version: "1.0.0",
  displayName: "SemaFrame SDK Example",
  description: "No-op connector and deterministic JSON exporter used by the SDK conformance suite.",
  publisher: { id: "semaframe", displayName: "SemaFrame" },
  compatibility: { minimumHostVersion: "0.4.0-rc.2" },
  entrypoint: { kind: "none" },
  providers: [
    {
      kind: "connector",
      id: "noop.connector",
      displayName: "No-op connector",
      configurationSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "array", items: {} },
      supportsCursor: false,
    },
    {
      kind: "exporter",
      id: "example.json.exporter",
      displayName: "Example JSON exporter",
      formats: [
        { id: "json", mediaType: "application/json", extensions: ["json"] },
      ],
      inputSchemaIds: ["semaframe.workspace.snapshot.v1"],
    },
  ],
  requestedPermissions: [
    { permission: "connector:execute" },
    { permission: "exporter:execute" },
  ],
  package: {
    byteLength: 0,
    sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    rootFiles: [],
  },
});
