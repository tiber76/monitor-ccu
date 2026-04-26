# CCU Monitor

Local dashboard for monitoring [Claude Code](https://claude.ai/code) token and cost usage in real time.

Reads directly from `~/.claude/projects/` — no API key, no external service.

## Features

**Dashboard tab**
- Today's cost, input/output/cache tokens updated live
- 7-day cost bar chart + model breakdown donut
- Live feed: every API call appears in < 1.5s with model, project, cost, cache R/W and session title

**Sessions tab**
- Day / hour evolution chart with linear regression trend line
- Full sessions table: tokens, cost, brut cost, delta vs average
- Expand any row to see subagent breakdown (type, model, cost)
- Chronological cost timeline with cumulative total and progress bar
- Filter by time window (today / 7d / 14d / 30d) and project name

## Requirements

- Node.js ≥ 18
- [Claude Code](https://claude.ai/code) installed and used at least once

## Usage

```bash
git clone https://github.com/tiber76/monitor-ccu.git
cd monitor-ccu
node server.mjs
```

Then open http://localhost:3333

## Compatibility

Works on macOS, Linux and Windows. All paths use Node.js built-ins (`path.join`, `os.homedir`, `path.sep`) — no hardcoded separators.

## How it works

The server scans `~/.claude/projects/**/*.jsonl` — the append-only session files written by Claude Code. It watches them for new lines (`fs.watchFile`, 800ms polling) and streams updates to the browser via Server-Sent Events. No database, no dependencies beyond Node.js built-ins.

Pricing is synced with the [public Anthropic pricing](https://www.anthropic.com/pricing) (Opus / Sonnet / Haiku).

## License

Copyright (c) 2026 Jeremy Lebair — All rights reserved. See [LICENSE](LICENSE).
