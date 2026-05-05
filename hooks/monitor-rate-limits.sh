#!/usr/bin/env bash
# Claude Code Stop hook — capture les rate limits Anthropic.
# Coût : zéro token — les données viennent des headers HTTP de la dernière réponse API,
# réinjectées par Claude Code dans le JSON de statut envoyé aux hooks.
#
# Installation :
#   cp hooks/monitor-rate-limits.sh ~/.claude/scripts/
#   chmod +x ~/.claude/scripts/monitor-rate-limits.sh
#
# Puis dans ~/.claude/settings.json :
#   "hooks": {
#     "Stop": [{
#       "matcher": "",
#       "hooks": [{"type":"command",
#                  "command":"~/.claude/scripts/monitor-rate-limits.sh",
#                  "timeout":3}]
#     }]
#   }
set -euo pipefail

CACHE_FILE="${HOME}/.claude/rate-limits-cache.json"
HISTORY_FILE="${HOME}/.claude/rate-limits-history.jsonl"

INPUT="$(cat)"

RATE_LIMITS="$(printf '%s' "${INPUT}" | jq -c '.rate_limits // empty' 2>/dev/null || true)"

if [[ -z "${RATE_LIMITS}" ]]; then
  exit 0
fi

# Fichier cache courant (dernier état — lu par le dashboard en temps réel)
printf '%s' "${INPUT}" | jq -c '{
  rate_limits: .rate_limits,
  updated_at: now
}' > "${CACHE_FILE}" 2>/dev/null || true

# Historique — une ligne JSONL par lecture (pour l'onglet Historique)
printf '%s' "${INPUT}" | jq -c '{
  ts: now,
  five_hour:         (.rate_limits.five_hour.used_percentage // null),
  five_hour_resets:  (.rate_limits.five_hour.resets_at      // null),
  seven_day:         (.rate_limits.seven_day.used_percentage // null),
  seven_day_resets:  (.rate_limits.seven_day.resets_at      // null),
  seven_day_opus:    (.rate_limits.seven_day_opus.used_percentage // null),
  seven_day_sonnet:  (.rate_limits.seven_day_sonnet.used_percentage // null)
}' >> "${HISTORY_FILE}" 2>/dev/null || true
