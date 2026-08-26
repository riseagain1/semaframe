import type { Plugin } from "vite";

/**
 * Vite intentionally inlines assets referenced from Worker entry graphs. The
 * upstream OCCT Emscripten loader contains one literal `new URL(...)` fallback,
 * which otherwise turns the 22.97 MB WASM binary into a 31 MB base64 Worker.
 * Replace only that exact fallback with a normal `?url&no-inline` import and
 * fail loudly if its generated source changes under a future explicitly
 * reviewed dependency update.
 */
export function externalizeReplicadOpenCascadeWasm(): Plugin {
  const dependencySuffix = "/node_modules/replicad-opencascadejs/dist/replicad_single.js";
  const sourceMarker = '(new URL("replicad_single.wasm",import.meta.url)).href';
  const externalMarker = "__semaframeOcctWasmUrl";
  const externalImport = 'import __semaframeOcctWasmUrl from "./replicad_single.wasm?url&no-inline";\n';
  return {
    name: "semaframe-externalize-replicad-occt-wasm",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?", 1)[0]?.replaceAll("\\", "/") ?? "";
      if (!cleanId.endsWith(dependencySuffix)) return null;
      const markerCount = code.split(sourceMarker).length - 1;
      if (markerCount !== 1) {
        throw new Error(
          `Expected exactly one OCCT WASM URL marker in ${cleanId}; found ${markerCount}. Review the pinned replicad-opencascadejs build before updating it.`,
        );
      }
      return {
        code: externalImport + code.replace(sourceMarker, externalMarker),
        map: null,
      };
    },
  };
}
