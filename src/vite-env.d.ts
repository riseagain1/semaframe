/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_CONTROL_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
