# Harness shims

## What they are

Claude Code hooks that put recall and reflection on a schedule. Without them the agent
decides when to call the tools, guided by the descriptions and the usage protocol. That is a
judgment call the model makes hundreds of times a session, and it makes it inconsistently: a
long session ends with no reflection, a new topic starts with no recall, and a compaction
throws away work nobody stored.

The shims replace the judgment with a cadence. Session start recalls. A substantial prompt
recalls. Compaction, stop, subagent stop, and session end capture. Nothing changes in the
substrate: the hooks are a client that speaks the same MCP wire an agent does.

## The two profiles

`aion init local` provisions the substrate and installs no hooks. Generation runs on Ollama.
This is what `aion init` has always done, now named.

`aion init full` asks for an Anthropic key, records it in `.env`, and installs the hooks. The
two go together. The shims push a lot of small capture work, and capture is Haiku-grade: read
a turn, shape it, store it. On the local path that same volume queues behind the one reflect
model every other caller is already waiting on. Routing generation to `claude-haiku-4-5` is
what makes the cadence affordable. Embeddings stay local either way, because the vector space
is the substrate.

`aion hooks install` does the hook half on its own, at any time.

## The events

| Event | Hook | What it does |
| --- | --- | --- |
| SessionStart | `session-start` | Recalls against a fixed grounding query and injects the pack. |
| UserPromptSubmit | `prompt-submit` | Recalls against the prompt, when the prompt is long enough to be a question. |
| PreCompact | `pre-compact` | Pushes the window compaction is about to discard. |
| Stop | `stop` | Stores the turn, or asks the model to store it. |
| SubagentStop | `subagent-stop` | Stores a subagent's turn the same way. |
| SessionEnd | `session-end` | Flushes the last window and drops the cursor. |
| PostToolUse | `post-tool-use` | Buffers a research tool result for the next flush. |

Every hook fails open. A service that is down, a transcript it cannot read, a malformed
payload, a fetch that never answers: all of them exit 0 with nothing on stdout. Ten seconds is
the hard ceiling on one fire. Blocking a turn over memory is worse than losing the memory.

The one exception is `stop --mode instruct`, which blocks by design.

## Selectivity

`prompt-submit` skips a prompt shorter than 40 characters. Below that a prompt is an
acknowledgement or a one-word steer, and recalling against it returns noise the agent then has
to read past. `--min-chars <n>` moves the line.

`session-start` and `prompt-submit` inject nothing when the pack comes back empty. An empty
pack is a real answer, and printing "no memories matched" into every session teaches the agent
to skim the block.

## Push or instruct

`--stop-mode push` is the default. The hook reads the turn out of the transcript and stores it
itself. The model never sees it happen and the turn ends when it would have ended.

`--stop-mode instruct` blocks the stop instead: exit code 2, with an instruction on stderr
telling the model to call the reflection tool with what the turn established. The model
summarizes its own work, which is better material than a raw transcript, and the next stop
sees the tool call in the tail and lets the turn end.

The trade is UX. Instruct mode adds a round trip to the end of every substantive turn and the
user watches it happen. Push is silent. Start on push; move to instruct if the stored episodes
read as transcript rather than as conclusions.

Instruct mode honors `stop_hook_active` strictly. A block while a block is already being
processed would never settle.

## Research capture

`--with-research-capture` adds a PostToolUse hook matching Slack, Linear, and Notion tool
calls. It buffers the tool name, a summary of the arguments, and up to 2000 characters of the
result, and the next flush folds them into the reflection as tool executions. Research a
session did once then survives the session.

It is off by default, and the reason is PHI. Redaction is deterministic and it targets
credentials: keys, tokens, connection strings. It does not detect patient data, and a Slack
message at a health company can carry it. Turning this on means patient data can reach the
graph through a channel nobody scoped for it. That decision belongs to whoever owns the data,
not to a default.

## Manual install

`aion hooks install` writes to `~/.claude/settings.json`, backing the file up first and
preserving every key and every hook that is not ours. Aion entries are recognized by
`hook-main.js` in the command path, so a second install replaces them rather than stacking.

Run through `./bin/aion`, the CLI sits inside a container that can reach neither the host repo
nor the host's Claude settings. It prints the block to merge by hand instead of failing. The
block looks like this, with the absolute path to your own checkout:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js prompt-submit"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js pre-compact",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js stop --mode push"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js subagent-stop",
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/aion-local/packages/cli/dist/hook-main.js session-end"
          }
        ]
      }
    ]
  }
}
```

`async: true` keeps a capture-only hook off the turn's critical path. SessionStart and
UserPromptSubmit cannot use it, because their output is the context they inject. Stop cannot
either, because it may block.

`aion hooks status` prints which entries are installed, their flags, and whether the build
exists. `aion hooks uninstall` removes exactly those entries.

## How the client works

The hook entry is `packages/cli/dist/hook-main.js`, compiled from a subtree that imports node
builtins and its own siblings, nothing else. It runs on the host's bare node, from whatever
directory the Claude session is in, with no install step and no container. A unit test scans
the subtree and fails the build on any other import.

Per fire it opens a streamable-HTTP MCP session against `http://127.0.0.1:8765/mcp`
(`AION_MCP_PORT` moves the port), makes one tool call, and deletes the session. The Claude
session id travels as the `session_id` tool argument, which overrides the transport identity,
so hook traffic and the model's own tool calls land in one memory stream rather than two.

The transcript is JSONL written by the harness for its own use, and its line shape drifts.
Every read is defensive: an unparseable line is skipped, and a message is recognized by walking
the shapes that plausibly carry one rather than by asserting a schema.

## State files

`~/.aion/hook-state/<session_id>.json`, one per Claude session. Each holds the transcript byte
offset of the last flush and the tool results buffered since. `session-end` deletes the file.

State is a convenience, never a dependency. Missing or corrupt, the next read starts 64KB from
the end of the transcript rather than at the beginning, and the session continues.
