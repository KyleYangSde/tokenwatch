# TokenWatch

MIT-licensed CLI for local Claude Code and Codex CLI token usage, estimated API costs, five-hour blocks, and desktop notifications. Node.js **18 or later**. One runtime dependency (commander); tables use plain text. Logs stay on your machine. No API keys or network requests at runtime.

## Install and run

From this checkout:

```sh
npm install
npm run build
npm test
npx --no-install tokenwatch report
```

Or package it and run the resulting archive through npx:

```sh
npm pack
npx --package ./tokenwatch-0.1.0.tgz tokenwatch report
```

For a global local installation: `npm install -g .`, then `tokenwatch report`.
The package is ready for npm publication but this checkout does not publish it. After publication, registry usage is `npx tokenwatch report` or `npm install -g tokenwatch` (ensure the registry package is this project).

## Log directories

Defaults:

- Claude: `~/.claude/projects`, recursively reading `<encoded-project-dir>/<sessionId>.jsonl` (including subagent logs).
- Codex: `~/.codex/sessions`, recursively reading `YYYY/MM/DD/rollout-*.jsonl`.

Override either directory before or after a command:

```sh
npx --no-install tokenwatch report --claude-dir ~/logs/claude --codex-dir ~/logs/codex
TOKENWATCH_CLAUDE_DIR=~/logs/claude TOKENWATCH_CODEX_DIR=~/logs/codex npx --no-install tokenwatch report
```

CLI paths take precedence over `TOKENWATCH_CLAUDE_DIR` / `TOKENWATCH_CODEX_DIR`. Point overrides at the projects/sessions directory itself. Missing directories are treated as empty. Invalid JSON lines (including incomplete final writes), missing usage, and invalid timestamps are skipped; unknown fields are ignored. Unreadable directories produce an actionable error.

Claude assistant records are deduplicated within each file by session, `message.id` and `requestId`; cumulative streaming snapshots use maximum token counts and the first timestamp. Entries without message IDs remain separate. Project comes from `cwd`, falling back to the encoded project directory (encoding is ambiguous, so it is not decoded).

Codex records obtain session/project from `session_meta` and model from `turn_context`. `token_count` uses `last_token_usage`, falling back to differences of cumulative totals. Null info and unchanged cumulative totals are skipped. Decreased counters start a fresh baseline. Input counts include cached input, so cached reads/writes are separated before pricing; reasoning is already included in output and is never added twice. Identical timestamp/usage records are deduplicated when totals are absent. Real local rollout logs were inspected; their optional `cache_write_input_tokens` is supported. Copying entire log files into the scanned tree can double-count usage across files.

## Report

```sh
tokenwatch report [--since YYYY-MM-DD] [--source claude|codex|all] [--by session|project|model|day] [--top N] [--json]
```

Default output includes all days, models and projects, plus the top 10 sessions. `--by` selects one table, and `--top` limits its rows. Days and `--since` use UTC; the since date is inclusive. Days sort newest first; other tables sort by cost, then tokens. Session IDs are prefixed with source. Cache token columns are separate from uncached input. Unknown models appear explicitly and contribute $0 to the estimate. JSON is an object whose keys are the selected grouping names, with full numeric totals and `unknownModels` arrays.

```text
By day
Group       Input  Output  Cache write  Cache read  Tokens  Cost USD  Unknown models
----------  -----  ------  -----------  ----------  ------  --------  --------------
2026-01-01  270    77      25           135         507     $0.0014   -

USD estimates; unknown models cost $0. Days use UTC.
```

```sh
tokenwatch report --since 2026-01-01 --source codex --by model --top 5
tokenwatch report --by session --json > usage.json
```

## Five-hour window

```sh
tokenwatch window [--limit-tokens N] [--limit-cost USD] [--source claude|codex|all] [--json]
```

A block starts at the first positive usage event. Its end is exactly five hours later. The first event at or after that end starts the next block; gaps do not create empty blocks. By default both sources contribute to a shared block; use `--source claude` for Claude-only tracking. No active usage block means the next event starts a new one. These locally inferred blocks are estimates, not provider quota measurements.

```text
Window: 2026-01-01T00:00:00.000Z → 2026-01-01T05:00:00.000Z
Used: 230 tokens; $0.0008
Burn rate: 230 tokens/hour; $0.0008/hour
Token limit: 460; predicted hit: 2026-01-01T02:00:00.000Z
Cost limit: unset; predicted hit: unavailable (no limit or no burn rate)
Reset in: 240 minutes
```

Burn rate uses time elapsed since the block start, including idle time. Predictions extrapolate that average and identify predictions after reset. At the exact start no elapsed burn rate exists; already-reached limits show the current time. `--json` returns the current window object or `null`; prediction timestamps are Unix milliseconds, start/end are ISO strings, and reset duration is seconds.

Optional `~/.tokenwatch.json`:

```json
{
  "limitTokens": 1000000,
  "limitCost": 20
}
```

CLI limits override config. Limits must be positive; token CLI limits are integers. Unknown config keys are ignored. Malformed config or invalid limits produce an error.

## Watch

```sh
tokenwatch watch [--interval sec] [--idle-minutes N] [--threshold-tokens N] [--threshold-cost USD] [--source claude|codex|all]
```

```sh
tokenwatch watch --interval 15 --idle-minutes 10 --threshold-tokens 500000 --threshold-cost 10
```

Polls directory listings and file mtime/ctime/size (default 30 seconds); only changed files are reparsed. Notifications:

- **Session ended:** no new usage for the idle duration (default 10 minutes). Existing sessions already idle at startup are ignored. New activity rearms the notification. “Ended” is an idle heuristic based on token events, not a process exit signal.
- **Window threshold:** tokens or USD reach a configured threshold. One notification per block, shared across both threshold types. An active block already above threshold at startup triggers once. Notification state is in memory and resets when watch restarts. Window limits from config do not automatically enable watch thresholds.

macOS uses `osascript`; Linux uses `notify-send` (install your distribution's libnotify tools and run in a desktop session). If a backend is absent or fails, notifications print to the console. Child processes receive argument arrays without a shell. Ctrl+C or SIGTERM stops polling.

```text
Watching logs every 15s; idle timeout 10 minutes. Press Ctrl+C to stop.
[TokenWatch] Session ended: claude:c1 (/work/demo); idle 10 minutes
[TokenWatch] Window threshold reached: 500100 tokens, $3.7500; reset 2026-01-01T05:00:00.000Z
```

All commands accept directory overrides and `--source`; see `tokenwatch --help` or `tokenwatch <command> --help`.

## Pricing and estimates

The explicit built-in table in `src/pricing.ts` uses standard USD per million API tokens, with dated snapshot suffixes normalized. Includes Claude Opus 3/4/4.1/4.5–4.8/5, Sonnet 3.5/3.7/4/4.5/4.6/5, Haiku 3/3.5/4.5, GPT-5/5.1/5.2 and supported Codex/mini/nano/pro variants, GPT-4.1 variants, GPT-4o variants, o1/o3/o3-mini/o4-mini, and codex-mini-latest. Unlisted versions stay unknown instead of inheriting guessed prices.

Sources checked 2026-10-10:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): listed Claude models use 5-minute cache writes at 1.25× input and reads at 0.1× input.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and individual model pages: [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), [GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [o3](https://developers.openai.com/api/docs/models/o3), [o4-mini](https://developers.openai.com/api/docs/models/o4-mini).

Estimates exclude subscriptions, discounts, tool fees, batch/fast modes, regional surcharges, long-context uplifts, and 1-hour Claude cache-write premiums. OpenAI cache-write tokens, when present, are estimated at 1.25× input. Actual invoices and provider limits can differ. New models and changed prices require updating the table and its tests. Unknown-model costs mean totals may understate usage cost.

## Development

```sh
npm install
npm run build
npm test
```

Fixture-based Vitest tests cover both parsers, cache pricing, unknown models, aggregation, five-hour window boundaries/predictions, and notification rearming. `npm run build` emits `dist/cli.js` with its shebang and executable permissions. `npm pack` runs the build through `prepare`; packaged files include compiled code, this README and the MIT license. Contributions welcome; run build and tests before submitting changes.

The test tooling stays on Vitest 3 / Vite 6 to support Node 18. npm currently reports development-only advisories in Vitest/mocker/tinypool; patched major versions require Node 20 or later. The packaged CLI ships only commander and has no dependency on this tooling.
