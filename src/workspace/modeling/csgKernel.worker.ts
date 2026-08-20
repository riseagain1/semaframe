/// <reference lib="webworker" />

import { setWasmUrl } from "manifold-3d/lib/wasm";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url&no-inline";
import { installCsgWorkerHandler, type CsgWorkerScope } from "./csgWorker";

// Manifold's default sibling lookup is valid in Node, but Vite serves the
// optimized dependency module from a different URL in development. Pin the
// Worker to Vite's explicit asset URL so dev and production both load the
// same local, fingerprinted binary instead of an HTML history fallback.
setWasmUrl(manifoldWasmUrl);
installCsgWorkerHandler(self as unknown as CsgWorkerScope);

export {};
