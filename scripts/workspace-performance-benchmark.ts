#!/usr/bin/env node

import {
  runWorkspacePerformanceBenchmark,
  type WorkspacePerformanceProfile,
} from "../src/benchmarks/workspacePerformanceBenchmark";

type CliOptions = Readonly<{
  profile: Exclude<WorkspacePerformanceProfile, "custom">;
  tiers?: readonly number[];
  samplesPerMeasurement?: number;
  warmupSamples?: number;
  pretty: boolean;
}>;

function usage(): string {
  return [
    "Usage: npx tsx scripts/workspace-performance-benchmark.ts [options]",
    "",
    "Options:",
    "  --profile <smoke|ci|full>  ci is the default; full adds the 2000-component tier",
    "  --tiers <n,n,...>          override profile tiers (5..2000)",
    "  --samples <n>              measured samples per operation (1..20)",
    "  --warmups <n>              unmeasured warmup samples (0..10)",
    "  --pretty                   pretty-print JSON output",
    "  --help                     show this help",
  ].join("\n");
}

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${option} requires an integer`);
  return Number(value);
}

function parseArgs(args: readonly string[]): CliOptions {
  let profile: Exclude<WorkspacePerformanceProfile, "custom"> = "ci";
  let tiers: number[] | undefined;
  let samplesPerMeasurement: number | undefined;
  let warmupSamples: number | undefined;
  let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--pretty") {
      pretty = true;
      continue;
    }
    if (argument === "--profile") {
      const value = valueAfter(args, index, argument);
      if (value !== "smoke" && value !== "ci" && value !== "full") {
        throw new Error("--profile must be smoke, ci, or full");
      }
      profile = value;
      index += 1;
      continue;
    }
    if (argument === "--tiers") {
      const value = valueAfter(args, index, argument);
      tiers = value.split(",").map((entry) => parseInteger(entry, argument));
      index += 1;
      continue;
    }
    if (argument === "--samples") {
      samplesPerMeasurement = parseInteger(valueAfter(args, index, argument), argument);
      index += 1;
      continue;
    }
    if (argument === "--warmups") {
      warmupSamples = parseInteger(valueAfter(args, index, argument), argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${argument}`);
  }
  return { profile, ...(tiers ? { tiers } : {}), samplesPerMeasurement, warmupSamples, pretty };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = runWorkspacePerformanceBenchmark({
    profile: options.profile,
    ...(options.tiers ? { tiers: options.tiers } : {}),
    ...(options.samplesPerMeasurement !== undefined
      ? { samplesPerMeasurement: options.samplesPerMeasurement }
      : {}),
    ...(options.warmupSamples !== undefined ? { warmupSamples: options.warmupSamples } : {}),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`);
} catch (error) {
  process.stderr.write(`Workspace performance benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
