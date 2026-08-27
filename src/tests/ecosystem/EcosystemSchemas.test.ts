import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import staticCatalogSchema from "../../ecosystem/catalog/staticTemplateCatalog.schema.json";
import templateDescriptorSchema from "../../ecosystem/catalog/templateDescriptor.schema.json";
import diagnosticSchema from "../../ecosystem/diagnostics/anonymousPerformanceDiagnostic.schema.json";
import { FIRST_PARTY_TEMPLATE_DESCRIPTORS } from "../../ecosystem/templates";
import { previewAnonymousPerformanceDiagnostic } from "../../ecosystem/diagnostics";

describe("ecosystem JSON Schema conformance", () => {
  it("compiles the public schemas and accepts canonical examples", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validateCatalog = ajv.compile(staticCatalogSchema);
    const validateTemplate = ajv.compile(templateDescriptorSchema);
    const validateDiagnostic = ajv.compile(diagnosticSchema);

    expect(validateCatalog({
      schemaVersion: "1",
      catalogId: "first-party",
      sequence: 1,
      generatedAt: "2026-08-27T00:00:00.000Z",
      expiresAt: "2026-08-28T00:00:00.000Z",
      entries: [],
      signature: { algorithm: "Ed25519", keyId: "release-key", value: "A".repeat(86) },
    }), JSON.stringify(validateCatalog.errors)).toBe(true);
    for (const descriptor of FIRST_PARTY_TEMPLATE_DESCRIPTORS) {
      expect(validateTemplate(descriptor), JSON.stringify(validateTemplate.errors)).toBe(true);
    }
    const payload = previewAnonymousPerformanceDiagnostic({
      releaseChannel: "preview",
      runtime: "desktop",
      renderer: "webgl",
      hardwareTier: "medium",
    }, { frame_p95_ms: 16.7 }, { enabled: true }).payload;
    expect(validateDiagnostic(payload), JSON.stringify(validateDiagnostic.errors)).toBe(true);
  });
});
