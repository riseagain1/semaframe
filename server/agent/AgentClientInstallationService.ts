export const AGENT_INSTALLATION_CLIENTS = ["codex", "claude"] as const;
export type AgentInstallationClient = (typeof AGENT_INSTALLATION_CLIENTS)[number];

export const AGENT_INSTALLATION_ACTIONS = ["status", "install", "update", "remove"] as const;
export type AgentInstallationAction = (typeof AGENT_INSTALLATION_ACTIONS)[number];

export const AGENT_INSTALLATION_STATES = [
  "installed",
  "not_installed",
  "outdated",
  "conflict",
  "client_unavailable",
  "error",
] as const;
export type AgentInstallationState = (typeof AGENT_INSTALLATION_STATES)[number];

export type AgentInstallationBackendResult = Readonly<{
  ok: boolean;
  client: AgentInstallationClient;
  action: AgentInstallationAction;
  state: AgentInstallationState;
  changed: boolean;
  detail: string;
  restartRequired: boolean;
}>;

/**
 * Narrow adapter implemented by the shared CLI installation module. The HTTP
 * layer deliberately has no process/path/config primitives of its own.
 */
export type AgentInstallationBackend = Readonly<{
  status(client: AgentInstallationClient): Promise<AgentInstallationBackendResult>;
  install(client: AgentInstallationClient): Promise<AgentInstallationBackendResult>;
  update(client: AgentInstallationClient): Promise<AgentInstallationBackendResult>;
  remove(client: AgentInstallationClient): Promise<AgentInstallationBackendResult>;
  close(): Promise<void>;
}>;

export type AgentClientInstallationView = Readonly<{
  client: AgentInstallationClient;
  displayName: "Codex" | "Claude Code";
  state: AgentInstallationState;
  changed: boolean;
  restartRequired: boolean;
  detail: string;
}>;

export type AgentClientInstallationSnapshot = Readonly<{
  version: 1;
  clients: readonly AgentClientInstallationView[];
}>;

export class AgentClientInstallationServiceError extends Error {
  readonly code:
    | "invalid_client"
    | "invalid_action"
    | "backend_invalid"
    | "operation_failed"
    | "operation_in_progress"
    | "service_closed";

  constructor(code: AgentClientInstallationServiceError["code"], message: string) {
    super(message);
    this.name = "AgentClientInstallationServiceError";
    this.code = code;
  }
}

const DISPLAY_NAMES = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
} as const);

const STATE_DETAILS = Object.freeze({
  installed: "The stable SemaFrame launcher is installed for this client.",
  not_installed: "SemaFrame is not installed for this client yet.",
  outdated: "This client has an older SemaFrame launcher configuration.",
  conflict: "A different SemaFrame configuration already uses the managed client entry.",
  client_unavailable: "This client is not available on this computer.",
  error: "The client installation could not be inspected safely.",
} satisfies Record<AgentInstallationState, string>);

function isClient(value: unknown): value is AgentInstallationClient {
  return value === "codex" || value === "claude";
}

function isAction(value: unknown): value is AgentInstallationAction {
  return value === "status" || value === "install" || value === "update" || value === "remove";
}

function isState(value: unknown): value is AgentInstallationState {
  return AGENT_INSTALLATION_STATES.includes(value as AgentInstallationState);
}

function validateBackendResult(
  result: unknown,
  client: AgentInstallationClient,
  action: AgentInstallationAction,
): AgentInstallationBackendResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new AgentClientInstallationServiceError("backend_invalid", "The installation backend returned invalid data.");
  }
  const value = result as Partial<AgentInstallationBackendResult>;
  if (
    value.client !== client || value.action !== action ||
    typeof value.ok !== "boolean" || !isState(value.state) ||
    typeof value.changed !== "boolean" || typeof value.restartRequired !== "boolean" ||
    typeof value.detail !== "string"
  ) {
    throw new AgentClientInstallationServiceError("backend_invalid", "The installation backend returned invalid data.");
  }
  return value as AgentInstallationBackendResult;
}

function publicView(result: AgentInstallationBackendResult): AgentClientInstallationView {
  // Backend diagnostics may include local paths or tool output. Return only
  // fixed, product-authored copy at the browser trust boundary.
  return Object.freeze({
    client: result.client,
    displayName: DISPLAY_NAMES[result.client],
    state: result.state,
    changed: result.changed,
    restartRequired: result.restartRequired,
    detail: STATE_DETAILS[result.state],
  });
}

/**
 * Serializes all client config mutations through the shared, shell-free
 * installer. It exposes no API capable of accepting a command, path, config
 * key, executable, argument vector, or environment value from the browser.
 */
export class AgentClientInstallationService {
  readonly #backend: AgentInstallationBackend;
  #operationTail: Promise<void> = Promise.resolve();
  #mutationInFlight = false;
  #mutationEpoch = 0;
  #statusOperation?: Readonly<{
    epoch: number;
    promise: Promise<AgentClientInstallationSnapshot>;
  }>;
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(backend: AgentInstallationBackend) {
    if (!backend
      || AGENT_INSTALLATION_ACTIONS.some((action) => typeof backend[action] !== "function")
      || typeof backend.close !== "function") {
      throw new TypeError("A complete Agent installation backend is required.");
    }
    this.#backend = backend;
  }

  async status(): Promise<AgentClientInstallationSnapshot> {
    if (this.#closing) return Promise.reject(this.#closedError());
    const epoch = this.#mutationEpoch;
    if (this.#statusOperation?.epoch === epoch) return this.#statusOperation.promise;
    const promise = this.#enqueue(async () => {
      // The two CLIs own separate configuration stores, so their read-only
      // inspections can run together. The surrounding queue remains a barrier
      // against every mutation: a snapshot never observes either side of an
      // in-flight config write.
      const clients = await Promise.all(AGENT_INSTALLATION_CLIENTS.map(async (client) => {
        try {
          return publicView(validateBackendResult(
            await this.#backend.status(client),
            client,
            "status",
          ));
        } catch (error) {
          if (error instanceof AgentClientInstallationServiceError && error.code === "backend_invalid") throw error;
          return publicView({
            ok: false,
            client,
            action: "status",
            state: "error",
            changed: false,
            detail: "",
            restartRequired: false,
          });
        }
      }));
      return Object.freeze({ version: 1 as const, clients: Object.freeze(clients) });
    });
    const operation = Object.freeze({ epoch, promise });
    this.#statusOperation = operation;
    const cleanup = () => {
      if (this.#statusOperation === operation) this.#statusOperation = undefined;
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  run(client: unknown, action: unknown): Promise<AgentClientInstallationView> {
    if (!isClient(client)) {
      return Promise.reject(new AgentClientInstallationServiceError(
        "invalid_client",
        "client must be codex or claude.",
      ));
    }
    if (!isAction(action) || action === "status") {
      return Promise.reject(new AgentClientInstallationServiceError(
        "invalid_action",
        "action must be install, update, or remove.",
      ));
    }
    if (this.#closing) return Promise.reject(this.#closedError());
    if (this.#mutationInFlight) {
      return Promise.reject(new AgentClientInstallationServiceError(
        "operation_in_progress",
        "Another Agent client installation change is already in progress.",
      ));
    }
    this.#mutationInFlight = true;
    this.#mutationEpoch += 1;
    const operation = this.#enqueue(async () => {
      try {
        return publicView(validateBackendResult(
          await this.#backend[action](client),
          client,
          action,
        ));
      } catch (error) {
        if (error instanceof AgentClientInstallationServiceError) throw error;
        throw new AgentClientInstallationServiceError(
          "operation_failed",
          "The client installation operation failed.",
        );
      }
    });
    const releaseMutation = () => { this.#mutationInFlight = false; };
    void operation.then(releaseMutation, releaseMutation);
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const closeBackend = () => this.#backend.close();
    // Join the global queue after closing admission. The backend then closes
    // its per-client queues, so no accepted config read/write is abandoned
    // between an official CLI remove, add, rollback, or verification command.
    const closing = this.#operationTail.then(closeBackend, closeBackend);
    this.#operationTail = closing.then(() => undefined, () => undefined);
    this.#closePromise = closing;
    return closing;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(this.#closedError());
    }
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #closedError(): AgentClientInstallationServiceError {
    return new AgentClientInstallationServiceError(
      "service_closed",
      "Agent client installation management is shutting down.",
    );
  }
}
