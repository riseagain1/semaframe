#!/usr/bin/env node

import { runSemaFrameCliEntrypoint } from "../scripts/lib/semaframe-cli.mjs";

const exitCode = await runSemaFrameCliEntrypoint(process.argv.slice(2));
process.exitCode = exitCode;
