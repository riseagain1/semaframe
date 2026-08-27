#!/usr/bin/env node

import { runSemaFrameCli } from "../scripts/lib/semaframe-cli.mjs";

const exitCode = await runSemaFrameCli(process.argv.slice(2));
process.exitCode = exitCode;
