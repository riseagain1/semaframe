export type RootEnvironmentLoadResult = Readonly<{ found: boolean }>;

export function loadRootEnvironment(options?: Readonly<{
  file?: string | URL | Buffer;
}>): RootEnvironmentLoadResult;
