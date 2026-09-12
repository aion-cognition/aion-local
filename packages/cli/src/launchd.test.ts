import { describe, expect, it } from 'vitest';

import {
  launchAgentPath,
  launchdCommands,
  MCP_EXIT_TIMEOUT_SECONDS,
  MCP_LAUNCH_LABEL,
  mcpScriptPath,
  renderLaunchdPlist,
} from './launchd.js';

const JOB = {
  nodePath: '/opt/homebrew/bin/node',
  repoDir: '/Users/someone/aion-local',
  environment: [
    ['AION_INSTALL_PROFILE', 'native'],
    ['AION_NEO4J_URI', 'bolt://127.0.0.1:7687'],
  ] as const,
  standardErrorPath: '/Users/someone/.aion/logs/aion-mcp.launchd.err.log',
};

describe('the launchd job that replaces the compose service', () => {
  const plist = renderLaunchdPlist(JOB);

  it('carries every property the compose service had, in the units launchd takes', () => {
    // `restart: unless-stopped` and a login start.
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // `stop_grace_period: 20s`. The drain finishes tool calls already running before it closes
    // the driver and SQLite, and a supervisor that kills at its own default cuts that in half.
    expect(MCP_EXIT_TIMEOUT_SECONDS).toBe(20);
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>20</integer>');
    // `env_file: .env`, rendered in, because a launchd job inherits nothing and nothing in this
    // build reads `.env` on the host.
    expect(plist).toContain(
      '<key>AION_NEO4J_URI</key>\n    <string>bolt://127.0.0.1:7687</string>',
    );
  });

  it('runs the built server from the repo, on the node that ran init', () => {
    expect(plist).toContain(`<string>${JOB.nodePath}</string>`);
    expect(plist).toContain(`<string>${mcpScriptPath(JOB.repoDir)}</string>`);
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${JOB.repoDir}</string>`);
    expect(mcpScriptPath(JOB.repoDir)).toBe(`${JOB.repoDir}/packages/mcp/dist/main.js`);
  });

  it('sends the stdout tee nowhere and keeps a file for what the logger cannot catch', () => {
    // The compose json-file driver capped a duplicate of the JSONL the service already writes.
    // Nothing rotates a launchd file, so the duplicate goes to /dev/null and the durable copy
    // stays the log file. stderr is the exception: a crash before the logger opens lands there.
    expect(plist).toContain('<key>StandardOutPath</key>\n  <string>/dev/null</string>');
    expect(plist).toContain(
      `<key>StandardErrorPath</key>\n  <string>${JOB.standardErrorPath}</string>`,
    );
  });

  it('says it is generated, because it lands in a directory people edit by hand', () => {
    expect(plist).toContain('aion init --install native');
    expect(plist).toContain(`${JOB.repoDir}/.env`);
  });

  it('escapes what XML cannot carry raw, in a path or a value', () => {
    const escaped = renderLaunchdPlist({
      ...JOB,
      repoDir: '/Users/a & b/<repo>',
      environment: [['AION_LOG_FILE', '/tmp/"quoted"/log']] as const,
    });

    expect(escaped).toContain('/Users/a &amp; b/&lt;repo&gt;');
    expect(escaped).toContain('/tmp/&quot;quoted&quot;/log');
    expect(escaped).not.toContain('<repo>');
  });

  it('renders no environment block at all when there is nothing to put in one', () => {
    // An empty `<dict>` is not valid where launchd expects pairs, and a job with no AION_* values
    // is a job whose `.env` was missing, which the caller reports its own way.
    expect(renderLaunchdPlist({ ...JOB, environment: [] })).not.toContain('EnvironmentVariables');
  });
});

describe('the commands init prints', () => {
  it('names the load, the restart and the unload against the same file', () => {
    const commands = launchdCommands('/Users/someone/Library/LaunchAgents/com.aion.mcp.plist');

    expect(commands[0]).toContain('launchctl bootstrap gui/$(id -u)');
    expect(commands.join('\n')).toContain(`kickstart -k gui/$(id -u)/${MCP_LAUNCH_LABEL}`);
    expect(commands.join('\n')).toContain('bootout');
  });

  it('puts the agent where launchd reads user agents from', () => {
    expect(launchAgentPath('/Users/someone')).toBe(
      `/Users/someone/Library/LaunchAgents/${MCP_LAUNCH_LABEL}.plist`,
    );
  });
});
