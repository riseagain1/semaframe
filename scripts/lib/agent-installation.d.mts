export type AgentClient = "codex" | "claude";
export type AgentInstallationAction = "install" | "status" | "update" | "remove";
export type AgentInstallationState =
  | "installed"
  | "not_installed"
  | "outdated"
  | "conflict"
  | "client_unavailable"
  | "error";

export interface AgentInstallationResult {
  readonly ok: boolean;
  readonly client: AgentClient;
  readonly action: AgentInstallationAction;
  readonly state: AgentInstallationState;
  readonly changed: boolean;
  readonly detail: string;
  readonly restartRequired: boolean;
}

export interface CapturedCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

export interface CapturedCommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof import("node:child_process").spawn;
}

export type SpawnCommand = (
  command: string,
  args: readonly string[],
  options?: CapturedCommandOptions,
) => Promise<CapturedCommandResult>;

export interface AgentInstallationServiceOptions {
  readonly packageRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodeExecutable?: string;
  /** Exact loopback Gateway origin used by the running host. */
  readonly gatewayUrl?: string;
  /** Test/embed override for production dependency resolution. */
  readonly resolveModule?: (specifier: string) => string;
  readonly spawnCommand?: SpawnCommand;
  readonly accessFile?: (path: string, mode?: number) => Promise<void>;
}

export interface AgentInstallationService {
  status(client: AgentClient): Promise<AgentInstallationResult>;
  install(client: AgentClient): Promise<AgentInstallationResult>;
  update(client: AgentClient): Promise<AgentInstallationResult>;
  remove(client: AgentClient): Promise<AgentInstallationResult>;
  close(): Promise<void>;
}

export function runCapturedCommand(
  command: string,
  args: readonly string[],
  options?: CapturedCommandOptions,
): Promise<CapturedCommandResult>;

export function createAgentInstallationService(
  options: AgentInstallationServiceOptions,
): AgentInstallationService;

export function runAgentInstallationAction(
  action: AgentInstallationAction,
  client: AgentClient,
  options: AgentInstallationServiceOptions,
): Promise<AgentInstallationResult>;
