import { USAGE_PROTOCOL } from '@aion/mcp';

import type { Writer } from './output.js';

/**
 * The last thing init prints: how to point a harness at the server it just brought up. The same
 * three lines on either install profile, because the registration is the same HTTP endpoint
 * whether the process behind it is a container or a launchd job.
 */

/** The one-time command that writes the server into Claude's user config. Every future session then connects with no per-session setup. */
export function registrationCommand(port: number): string {
  return `claude mcp add -s user --transport http aion http://127.0.0.1:${String(port)}/mcp`;
}

/** Same registration, as the raw JSON Claude Code's own config uses for an HTTP MCP server. For manual edits and other harnesses. */
export function registrationJson(port: number): string {
  return JSON.stringify(
    { mcpServers: { aion: { type: 'http', url: `http://127.0.0.1:${String(port)}/mcp` } } },
    null,
    2,
  );
}

export function renderRegistration(port: number, write: Writer): void {
  write('');
  write('MCP registration (one time; every future Claude Code session connects automatically):');
  write(`  ${registrationCommand(port)}`);
  write('');
  write('Equivalent raw JSON, for manual config or other harnesses:');
  write(registrationJson(port));
  write('');
  write('Add to your CLAUDE.md so the agent knows when to call recall and reflection:');
  write('');
  write(USAGE_PROTOCOL);
}
