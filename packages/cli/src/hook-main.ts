#!/usr/bin/env node
import { main } from './hook/run.js';

/**
 * A second compiled entry beside `main.ts`, and not a subcommand of it. Claude Code runs a
 * hook as `node <path> <event>` on the host's own node, so this file and everything it
 * reaches has to load without the workspace: no @aion packages, no zod, no node_modules.
 * `hook/run.ts` states the rest of that constraint.
 */
process.exitCode = await main(process.argv.slice(2));
