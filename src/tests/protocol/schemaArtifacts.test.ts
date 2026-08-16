import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import assetManifest from "../../assets/assetManifest.json";
import assetManifestSchema from "../../assets/assetManifest.schema.json";
import workspaceProjectSchema from "../../workspace/persistence/workspaceProject.schema.json";
import workspaceProtocolSchema from "../../workspace/protocol/workspaceProtocol.schema.json";

describe("versioned schema artifacts", () => {
  it("strict-compiles all schemas and validates the shipped asset manifest", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
    addFormats(ajv);
    ajv.addSchema(workspaceProtocolSchema);

    const validateAssets = ajv.compile(assetManifestSchema);
    expect(validateAssets(assetManifest), JSON.stringify(validateAssets.errors)).toBe(true);

    expect(() => ajv.compile(workspaceProjectSchema)).not.toThrow();
  });
});
