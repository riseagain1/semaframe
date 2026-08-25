export type ShutdownServer = Readonly<{
  close(callback: (error?: Error) => void): void;
}>;

export type ShutdownGateway = Readonly<{
  close(): void;
}>;

export type ShutdownHandler = Readonly<{
  close(): Promise<void>;
}>;

/** Stops admission first, revokes live authority, then waits for durable cleanup. */
export async function closeAgentGatewayStack(options: Readonly<{
  server: ShutdownServer;
  gateway: ShutdownGateway;
  handler: ShutdownHandler;
  timeoutMs: number;
}>): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("Agent Gateway shutdown timeout must be a positive safe integer.");
  }
  const failures: unknown[] = [];
  const serverClosed = new Promise<void>((resolve, reject) => {
    try {
      options.server.close((error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
  try {
    options.gateway.close();
  } catch (error) {
    failures.push(error);
  }
  const cleanupSettled = Promise.allSettled([serverClosed, options.handler.close()]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("Agent Gateway shutdown exceeded its cleanup deadline.")),
      options.timeoutMs,
    );
  });
  let settled: Awaited<typeof cleanupSettled>;
  try {
    settled = await Promise.race([cleanupSettled, timeout]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  for (const result of settled) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "The Agent Gateway shutdown encountered multiple failures.");
  }
}
