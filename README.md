<p align="center">
  <img src="logo.svg" alt="Claude Code Usage Monitor logo" width="96" height="96" />
</p>

<h1 align="center">Claude Code Usage Monitor</h1>

<p align="center">Local dashboard for monitoring <a href="https://claude.ai/code">Claude Code</a> token and cost usage in real time.</p>


Reads directly from `~/.claude/projects/` — no API key, no external service, no telemetry.

---

## Features

**Dashboard tab**
- Today's cost shown in **two flavors**: *plan* (Claude Code subscription, cache read excluded) and *theoretical API* (with cache read at full Anthropic API rate)
- Live header counters, 7-day cost bar chart, model breakdown donut
- **Live sessions panel** — the 3 most recently active sessions with full breakdown: tokens, cost, per-model recap, sub-agents table (agent · description · model · in/out/CR/CW · cost). "Active" badge if last event < 90s
- **Live API feed** aligned next to it — every API call appears in < 1.5s with model, project, cost, cache R/W and session title

**History tab** *(requires the Stop hook — see below)*
- **Plan usage history** over 7 / 14 / 30 / 90 days
- **5-hour limit** — daily peak bar chart (max % reached during the day), color-coded: green < 75%, amber 75–90%, red ≥ 90%
- **Weekly limit (all models)** — end-of-day value chart to track the weekly counter trend
- **Weekly Opus vs Sonnet** — dual bar chart if model-specific data is available
- Data accumulates automatically from the first Claude message after hook setup — zero tokens consumed

**Sessions tab**
- **KPI strip** — plan cost, theoretical API cost, sessions count, avg cost / session, cache hit rate, cache savings, sub-agents count, **max context %**
- Top projects mini chart (horizontal bars)
- Day / hour evolution chart with consistent linear regression trend (empty buckets are filled, so the slope stays coherent across granularities)
- Full sessions table: tokens, cost (plan & API), delta vs average, **context column with colored bar** (green < 40%, amber 40–80%, red > 80% — the thresholds Anthropic recommends `/compact` at)
- Expand any row to see:
  - **Sub-agents breakdown** (type, description, model, full token + cost detail)
  - **Top 10 tools** with attributed cost (parent + sub-agents) — sortable by *plan $ / output / cache write* to see what's actually consuming
  - **Per-tool invocation drill-down** — click any tool row to see the exact `Bash` commands, `Read` / `Edit` / `Write` file paths, `Grep` patterns, `WebFetch` URLs, `Agent` prompts… every invocation is tagged `SUB-AGENT` if it came from a Task call
- Chronological cost timeline with cumulative total and progress bar
- Filters: time window (today / 3d / 7d / 14d / 30d) and project (dropdown auto-populated, sorted by cost)
- **Auto-loads** today's data when you first open the tab
- Detailed tooltips on every cell explaining the calculation

**Tips tab**
Curated list of useful Claude Code slash commands grouped by topic: context management (`/compact`, `/clear`), memory (`/memory`, `/init`), models (`/model`, `/fast`), workflows (`/review`, `/security-review`, `/loop`, `/schedule`), config (`/permissions`, `/mcp`, `/ide`, `/hooks`), document skills, plus cost best practices.

**Formulas tab**
All formulas used in the board explained with worked numerical examples — every figure on the dashboard is locally and deterministically reproducible from the JSONL files.

**Bilingual**
FR / EN toggle in the header, detects browser language at first load, choice persisted in `localStorage`. Static and dynamic text are both translated.

## Plan usage history (Stop hook)

The **History tab** shows your 5-hour and weekly rate-limit consumption over time. This data is captured by a lightweight shell hook that Claude Code fires after each response — **no tokens consumed, no API call**.

The hook reads `rate_limits` from the JSON payload Claude Code already sends to hooks (sourced from `anthropic-ratelimit-unified-*` HTTP response headers), and appends one line to `~/.claude/rate-limits-history.jsonl`.

### Setup

**1 — Copy the hook script**

```bash
cp hooks/monitor-rate-limits.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/monitor-rate-limits.sh
```

**2 — Register the Stop hook in `~/.claude/settings.json`**

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/scripts/monitor-rate-limits.sh",
        "timeout": 3
      }]
    }]
  }
}
```

Data will appear in the History tab from the very next Claude message. The hook writes two files:
- `~/.claude/rate-limits-cache.json` — latest snapshot (used by the live dashboard widget)
- `~/.claude/rate-limits-history.jsonl` — append-only log (used by the History tab)

## Why two costs (plan vs API)?

On the Claude Code subscription, Anthropic does **not bill cache reads** — they're free as part of the plan. On the raw Anthropic API, cache reads cost 10% of the input rate. The board shows both: the *plan* figure is what the call actually costs you on your subscription; the *API* figure is what the same usage would cost via the API and gives you a sense of the value the subscription delivers.

## Requirements

- Node.js ≥ 18
- [Claude Code](https://claude.ai/code) installed and used at least once

## Usage

```bash
git clone https://github.com/tiber76/monitor-ccu.git
cd monitor-ccu
node server.mjs
```

Then open http://localhost:3333 (it opens automatically).

## Compatibility

Works on macOS, Linux and Windows. All paths use Node.js built-ins (`path.join`, `os.homedir`, `path.sep`) — no hardcoded separators.

## How it works

The server scans `~/.claude/projects/**/*.jsonl` — the append-only session files written by Claude Code. It watches them for new lines (`fs.watchFile`, 800ms polling) and streams updates to the browser via Server-Sent Events. No database, no dependencies beyond Node.js built-ins.

Pricing is synced with the [public Anthropic pricing](https://www.anthropic.com/pricing) (Opus / Sonnet / Haiku). Context window limits per model are also baked in (Opus 4.7 [1m] and Sonnet 4.6 = 1M; Opus 4.6/4.5, Haiku 4.5, Opus 4 = 200K).

Claude Code logs the same assistant turn twice in the JSONL when it contains `tool_use` blocks — the parser deduplicates on `message.id` so each call is counted exactly once (this matters: without dedup, costs are inflated by ~50% on tool-heavy sessions).

## License

Copyright (c) 2026 Jeremy Lebair — All rights reserved. See [LICENSE](LICENSE).
