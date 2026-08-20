/// <reference lib="webworker" />

import { installRealityAssetWorkerHandler, type RealityAssetWorkerScope } from "./preflightWorker";

installRealityAssetWorkerHandler(self as unknown as RealityAssetWorkerScope);

export {};
