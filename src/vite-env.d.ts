/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_CONTROL_ENDPOINT?: string;
  /** Canonical origin used by the separately served XR renderer. Defaults to its own origin. */
  readonly VITE_XR_GATEWAY_ORIGIN?: string;
  /** Absolute xr.html URL placed in one-time headset pairing links by the authoritative host. */
  readonly VITE_XR_PUBLIC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
