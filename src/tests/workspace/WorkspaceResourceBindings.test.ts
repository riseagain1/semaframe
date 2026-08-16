import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_REGISTRY,
  deterministicDigest,
  type JSONObject,
} from "../../workspace/components";
import {
  assertWorkspaceResourceAgentWriteSafe,
  assertWorkspaceResourceInputSafe,
  assertWorkspaceResourceSafe,
  findEmbeddedSecretPath,
  normalizeInlineSnapshotResource,
  workspaceConnectorCapabilityManifest,
  WorkspaceResourceValidationError,
  type WorkspaceResource,
} from "../../workspace/data";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const stockOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["labels", "series"],
  properties: {
    labels: { type: "array", items: { type: "string" } },
    series: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "values"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          values: { type: "array", items: { type: "number" } },
          color: { type: "string" },
        },
      },
    },
  },
} as const;

const stockData = {
  labels: ["09:30", "09:31", "09:32"],
  series: [{
    id: "close",
    label: "Close",
    values: [188.4, 189.1, 188.8],
    color: "#68D5FF",
  }],
};

function stockResource(overrides: Partial<WorkspaceResource> = {}): WorkspaceResource {
  return {
    id: "RES_stock",
    label: "ACME intraday",
    connectorType: "inline.snapshot",
    connectorVersion: "1.0.0",
    outputSchema: stockOutputSchema,
    config: {},
    policy: { mode: "manual", offline: "keep_last_good" },
    snapshot: {
      data: structuredClone(stockData),
      contentHash: deterministicDigest(stockData),
      retrievedAt: "2026-08-15T01:02:03.000Z",
      stale: false,
      provenance: [],
    },
    status: "ready",
    ...overrides,
  };
}

function chartStore(resource: WorkspaceResource, sourcePath = "$.labels", targetProp = "labels") {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "stock_chart", [{
    op: "create_component",
    op_id: "create_chart",
    id: "CMP_000001",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
    placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
  }, {
    op: "upsert_resource",
    op_id: "upsert_stock",
    resource,
  }, {
    op: "bind_resource",
    op_id: "bind_stock",
    binding: {
      kind: "resource_binding",
      id: "BIND_stock",
      resourceId: resource.id,
      componentId: "CMP_000001",
      targetProp,
      sourcePath,
      mode: "snapshot",
      transform: { kind: "identity" },
      enabled: true,
    },
  }]));
  return store;
}

describe("secure Workspace snapshot bindings", () => {
  it("projects stock-like labels and series without mutating canonical props or revision", () => {
    const store = new WorkspaceStore();
    const resource = stockResource();
    store.apply(workspaceBatch(store, "stock_chart", [{
      op: "create_component",
      op_id: "create_chart",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "upsert_resource",
      op_id: "upsert_stock",
      resource,
    }, {
      op: "bind_resource",
      op_id: "bind_labels",
      binding: {
        kind: "resource_binding",
        id: "BIND_labels",
        resourceId: resource.id,
        componentId: "CMP_000001",
        targetProp: "labels",
        sourcePath: "$.labels",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }, {
      op: "bind_resource",
      op_id: "bind_series",
      binding: {
        kind: "resource_binding",
        id: "BIND_series",
        resourceId: resource.id,
        componentId: "CMP_000001",
        targetProp: "series",
        sourcePath: "/series",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]));

    const revision = store.getRevision();
    expect(store.getState().components.get("CMP_000001")?.props).toMatchObject({ labels: [], series: [] });
    const rendered = toRenderSnapshot(store.getState());
    expect(rendered.components[0]?.props).toMatchObject(stockData);
    expect(rendered.bindingDiagnostics).toBeUndefined();
    expect(store.getState().components.get("CMP_000001")?.props).toMatchObject({ labels: [], series: [] });
    expect(store.getRevision()).toBe(revision);
  });

  it("rejects a missing source path at commit", () => {
    expect(() => chartStore(stockResource(), "$.prices.missing")).toThrow(/does not exist/u);
  });

  it("applies bounded number and template transforms to text windows", () => {
    const store = new WorkspaceStore();
    const quoteData = { quote: { price: 188.456 } };
    store.apply(workspaceBatch(store, "quote_text", [{
      op: "create_component",
      op_id: "formatted",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("text"),
      placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 0 } },
    }, {
      op: "create_component",
      op_id: "templated",
      id: "CMP_000002",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("text"),
      placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
    }, {
      op: "upsert_resource",
      op_id: "quote",
      resource: {
        id: "RES_quote",
        label: "Quote",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        outputSchema: {
          type: "object",
          required: ["quote"],
          properties: {
            quote: {
              type: "object",
              required: ["price"],
              properties: { price: { type: "number" } },
            },
          },
        },
        config: {},
        policy: { mode: "manual", offline: "keep_last_good" },
        snapshot: {
          data: quoteData,
          contentHash: deterministicDigest(quoteData),
          retrievedAt: "2026-08-15T01:02:03.000Z",
          stale: false,
          provenance: [],
        },
        status: "ready",
      },
    }, {
      op: "bind_resource",
      op_id: "format",
      binding: {
        kind: "resource_binding",
        id: "BIND_format",
        resourceId: "RES_quote",
        componentId: "CMP_000001",
        targetProp: "text",
        sourcePath: "$.quote.price",
        mode: "snapshot",
        transform: { kind: "format_number", decimals: 2, prefix: "$" },
        enabled: true,
      },
    }, {
      op: "bind_resource",
      op_id: "template",
      binding: {
        kind: "resource_binding",
        id: "BIND_template",
        resourceId: "RES_quote",
        componentId: "CMP_000002",
        targetProp: "text",
        sourcePath: "$.quote.price",
        mode: "snapshot",
        transform: { kind: "template", template: "Last {{ value }}" },
        enabled: true,
      },
    }]));

    const rendered = toRenderSnapshot(store.getState());
    expect(rendered.components.find(({ id }) => id === "CMP_000001")?.props.text).toBe("$188.46");
    expect(rendered.components.find(({ id }) => id === "CMP_000002")?.props.text).toBe("Last 188.456");
  });

  it("rejects a source value that violates the target component props schema at commit", () => {
    const numericLabels = stockResource({
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["labels"],
        properties: { labels: { type: "array", items: { type: "number" } } },
      },
      snapshot: {
        data: { labels: [1, 2, 3] },
        contentHash: "fixture",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        stale: false,
        provenance: [],
      },
    });
    expect(() => chartStore(numericLabels)).toThrow(/does not produce valid props/u);
  });

  it("detects credential tokens in camel, snake, and dash prefixed or suffixed keys", () => {
    const credentialValues: Array<{ value: JSONObject; path: string }> = [
      { value: { dbPassword: "secret" }, path: "$.dbPassword" },
      { value: { passwordValue: "secret" }, path: "$.passwordValue" },
      { value: { database_password: "secret" }, path: "$.database_password" },
      { value: { nested: { "database-password-hash": "secret" } }, path: "$.nested.database-password-hash" },
      { value: { secretValue: "secret" }, path: "$.secretValue" },
      { value: { "encrypted-secret": "secret" }, path: "$.encrypted-secret" },
      { value: { tokenValue: "secret" }, path: "$.tokenValue" },
      { value: { "session-token-value": "secret" }, path: "$.session-token-value" },
      { value: { credentialValue: "secret" }, path: "$.credentialValue" },
      { value: { "provider-credential-id": "secret" }, path: "$.provider-credential-id" },
      { value: { accessTokenValue: "secret" }, path: "$.accessTokenValue" },
      { value: { service_access_token: "secret" }, path: "$.service_access_token" },
      { value: { nested: { apiKeyValue: "secret" } }, path: "$.nested.apiKeyValue" },
      { value: { list: [{ clientSecret: "secret" }] }, path: "$.list[0].clientSecret" },
      { value: { provider: { OpenAIAPIKey: "secret" } }, path: "$.provider.OpenAIAPIKey" },
      { value: { legacy: { accesstoken: "secret" } }, path: "$.legacy.accesstoken" },
      { value: { headers: { "x-api-key": "secret" } }, path: "$.headers.x-api-key" },
    ];
    for (const { value, path } of credentialValues) {
      expect(findEmbeddedSecretPath(value)).toBe(path);
      expect(() => assertWorkspaceResourceSafe(stockResource({ config: value }))).toThrow(
        WorkspaceResourceValidationError,
      );
    }
    expect(findEmbeddedSecretPath({ tokenCount: 3 })).toBeNull();
    expect(findEmbeddedSecretPath({ accessTokenCount: 3 })).toBe("$.accessTokenCount");
  });

  it("cannot normalize or validate credential-token keys into durable inline resources", () => {
    const unsafeData = { quote: { accessTokenValue: "must-not-persist" } };
    const unsafeSnapshotResource = stockResource({
      outputSchema: { type: "object", additionalProperties: true },
      snapshot: {
        data: unsafeData,
        contentHash: deterministicDigest(unsafeData),
        retrievedAt: "2026-08-15T01:02:03.000Z",
        stale: false,
        provenance: [],
      },
    });

    expect(() => normalizeInlineSnapshotResource(unsafeSnapshotResource, 1_765_765_323_000)).toThrow(
      /Embedded credential-like field is forbidden at \$\.quote\.accessTokenValue/u,
    );
    expect(() => assertWorkspaceResourceInputSafe(unsafeSnapshotResource)).toThrow(
      WorkspaceResourceValidationError,
    );
    expect(() => assertWorkspaceResourceSafe(stockResource({
      config: { database_password: "must-not-persist" },
    }))).toThrow(/Embedded credential-like field is forbidden at \$\.database_password/u);
  });

  it("rejects invalid output schemas, mismatched snapshots, and inconsistent status", () => {
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: {
        type: "object",
        properties: { symbol: { type: "string", pattern: "^(a+)+$" } },
      },
    }))).toThrow(/forbidden regex keyword pattern/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: {
        type: "object",
        patternProperties: { "^(a+)+$": { type: "string" } },
      },
    }))).toThrow(/forbidden regex keyword patternProperties/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: {
        $ref: "#/payload",
        payload: { type: "string", pattern: "^(a+)+$" },
      },
    }))).toThrow(/forbidden reference keyword \$ref/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: { allOf: [{ type: "object" }, { maxProperties: 8 }] },
    }))).toThrow(/complexity keyword allOf/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: { type: "array", uniqueItems: true, items: { type: "object" } },
    }))).toThrow(/complexity keyword uniqueItems/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: { type: "object", description: "x".repeat(66_000) },
    }))).toThrow(/outputSchema exceeds 65536 bytes/u);
    const manyProperties = Object.fromEntries(Array.from(
      { length: 260 },
      (_, index) => [`field_${index}`, { type: "string" }],
    ));
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: { type: "object", properties: manyProperties },
    }))).toThrow(/complexity keyword schemaNodeLimit/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      connectorVersion: "9.9.9",
    }))).toThrow(/use inline\.snapshot@1\.0\.0/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      outputSchema: { type: "not-a-json-schema-type" },
    }))).toThrow(/outputSchema is invalid/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      snapshot: {
        data: { labels: [1], series: [] },
        contentHash: "fixture",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        stale: false,
        provenance: [],
      },
    }))).toThrow(/does not match outputSchema/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      status: "stale",
      snapshot: {
        data: structuredClone(stockData),
        contentHash: "fixture",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        stale: false,
        provenance: [],
      },
    }))).toThrow(/canonical host-owned form/u);
    expect(() => assertWorkspaceResourceSafe(stockResource({
      snapshot: {
        data: structuredClone(stockData),
        contentHash: "fixture",
        retrievedAt: "August 15, 2026",
        stale: false,
        provenance: [],
      },
    }))).toThrow(/not a valid ISO timestamp/u);
  });

  it("rejects unsafe resources at the command boundary without changing Workspace state", () => {
    const store = new WorkspaceStore();
    const mismatched = stockResource({
      snapshot: {
        data: { labels: [1], series: [] },
        contentHash: "fixture",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        stale: false,
        provenance: [],
      },
    });
    expect(() => store.apply(workspaceBatch(store, "bad_snapshot", [{
      op: "upsert_resource",
      op_id: "bad_snapshot",
      resource: mismatched,
    }]))).toThrow(/does not match outputSchema/u);
    expect(() => store.apply(workspaceBatch(store, "bad_secret", [{
      op: "upsert_resource",
      op_id: "bad_secret",
      resource: stockResource({ config: { accessToken: "must-not-persist" } }),
    }]))).toThrow(/Embedded credential-like field/u);
    expect(store.getRevision()).toBe(0);
    expect(store.getState().resources.size).toBe(0);
  });

  it("host-normalizes the non-executable inline snapshot hash, time, status, and provenance", () => {
    const normalized = normalizeInlineSnapshotResource(stockResource({
      snapshot: {
        data: structuredClone(stockData),
        contentHash: "caller-claimed-hash",
        retrievedAt: "2020-01-01T00:00:00.000Z",
        stale: true,
        provenance: [{
          title: "Caller claim",
          uri: "https://unverified.invalid",
          retrievedAt: "2020-01-01T00:00:00.000Z",
        }],
      },
      status: "error",
      lastError: "caller claim",
    }), 1_765_765_323_000);

    expect(normalized).toMatchObject({
      connectorType: "inline.snapshot",
      connectorVersion: "1.0.0",
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      status: "ready",
      snapshot: {
        contentHash: deterministicDigest(stockData),
        retrievedAt: new Date(1_765_765_323_000).toISOString(),
        stale: false,
        provenance: [{ publisher: "Scene Thread inline snapshot" }],
      },
    });
    expect(normalized).not.toHaveProperty("lastError");
    expect(normalized).not.toHaveProperty("secretRef");
  });

  it("rejects tampering with every host-owned inline snapshot field", () => {
    const canonical = normalizeInlineSnapshotResource(stockResource(), 1_765_765_323_000);
    const variants: WorkspaceResource[] = [
      { ...structuredClone(canonical), snapshot: { ...structuredClone(canonical.snapshot!), contentHash: "caller-hash" } },
      { ...structuredClone(canonical), policy: { mode: "on_open", offline: "keep_last_good" } },
      { ...structuredClone(canonical), snapshot: { ...structuredClone(canonical.snapshot!), provenance: [] } },
      { ...structuredClone(canonical), status: "error" },
      { ...structuredClone(canonical), lastError: "connector leaked a credential" },
    ];
    for (const variant of variants) {
      expect(() => assertWorkspaceResourceSafe(variant)).toThrow(/canonical host-owned form/u);
    }
  });

  it("allows only registered host-normalized connector writes from Agents", () => {
    expect(() => assertWorkspaceResourceAgentWriteSafe(stockResource())).not.toThrow();
    expect(() => assertWorkspaceResourceAgentWriteSafe({
      ...stockResource(),
      connectorType: "inline-json",
      connectorVersion: "1",
    })).toThrow(/not available for new Agent writes/u);
    expect(() => assertWorkspaceResourceAgentWriteSafe({
      ...stockResource(),
      connectorType: "unknown-connector",
      connectorVersion: "1",
    })).toThrow(/not available for new Agent writes/u);
    expect(() => assertWorkspaceResourceInputSafe({
      ...stockResource(),
      config: { headers: { authorizationHeader: "Bearer credential-sentinel" } },
    })).toThrow(/credential-like field/u);
    expect(() => assertWorkspaceResourceInputSafe({
      ...stockResource(),
      config: { headers: { custom: "Bearer credential-sentinel" } },
    })).toThrow(/credential-like value/u);
  });

  it("rejects live, duplicate enabled target, and invalid transform bindings at commit", () => {
    const liveStore = new WorkspaceStore();
    liveStore.apply(workspaceBatch(liveStore, "live_setup", [{
      op: "create_component",
      op_id: "create_chart",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "upsert_resource",
      op_id: "upsert_stock",
      resource: stockResource(),
    }]));
    const liveRevision = liveStore.getRevision();
    expect(() => liveStore.apply(workspaceBatch(liveStore, "live_bind", [{
      op: "bind_resource",
      op_id: "bind_live",
      binding: {
        kind: "resource_binding",
        id: "BIND_live",
        resourceId: "RES_stock",
        componentId: "CMP_000001",
        targetProp: "labels",
        sourcePath: "$.labels",
        mode: "live",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]))).toThrow(/unavailable until a trusted connector runtime/u);
    expect(liveStore.getRevision()).toBe(liveRevision);

    const duplicateStore = chartStore(stockResource());
    const duplicateRevision = duplicateStore.getRevision();
    expect(() => duplicateStore.apply(workspaceBatch(duplicateStore, "duplicate_bind", [{
      op: "bind_resource",
      op_id: "bind_duplicate",
      binding: {
        kind: "resource_binding",
        id: "BIND_duplicate",
        resourceId: "RES_stock",
        componentId: "CMP_000001",
        targetProp: "labels",
        sourcePath: "$.labels",
        mode: "snapshot",
        transform: { kind: "identity" },
        enabled: true,
      },
    }]))).toThrow(/already targets/u);
    expect(duplicateStore.getRevision()).toBe(duplicateRevision);

    expect(() => {
      const invalidStore = new WorkspaceStore();
      invalidStore.apply(workspaceBatch(invalidStore, "invalid_transform", [{
        op: "create_component",
        op_id: "create_chart",
        id: "CMP_000001",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("chart"),
        placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      }, {
        op: "upsert_resource",
        op_id: "upsert_stock",
        resource: stockResource(),
      }, {
        op: "bind_resource",
        op_id: "bind_invalid_transform",
        binding: {
          kind: "resource_binding",
          id: "BIND_invalid_transform",
          resourceId: "RES_stock",
          componentId: "CMP_000001",
          targetProp: "labels",
          sourcePath: "$.labels",
          mode: "snapshot",
          transform: { kind: "format_number" },
          enabled: true,
        },
      }]));
    }).toThrow(/format_number requires one finite number/u);
  });

  it("publishes bounded snapshot and host-approved feed connector capabilities", () => {
    const manifest = workspaceConnectorCapabilityManifest() as Array<Record<string, unknown>>;
    expect(new TextEncoder().encode(JSON.stringify(manifest)).byteLength).toBeLessThan(32_000);
    expect(manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        execution: "none",
        networkAccess: false,
        snapshotAuthority: "host_normalized",
        agentWritePolicy: "allowed",
        recommendedOutputSchemas: [expect.objectContaining({ id: "chart.timeseries.v1" })],
      }),
      expect.objectContaining({ connectorType: "inline-json", connectorVersion: "1", execution: "none", agentWritePolicy: "legacy_read_only" }),
      expect.objectContaining({ connectorType: "fixture", connectorVersion: "1", execution: "none", agentWritePolicy: "test_only" }),
      expect.objectContaining({
        connectorType: "http.feed",
        connectorVersion: "1.0.0",
        execution: "host",
        networkAccess: true,
        snapshotAuthority: "host_normalized",
        agentWritePolicy: "host_approval_required",
      }),
    ]));
  });
});
