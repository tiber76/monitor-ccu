#!/usr/bin/env node
// CCU Monitor — serveur HTTP local (port 3333) + SSE + watcher JSONL
// Lance avec : node tmp/monitor-ccu/server.mjs
import { createServer } from 'node:http';
import { readFileSync, statSync, readdirSync, watchFile } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, basename, relative, sep } from 'node:path';
import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const LABELS_PATH   = join(homedir(), '.claude', 'session-labels.json');

// Pricing $/M tokens — copié depuis ~/.claude/scripts/ccu-by-uuid.mjs
const PRICING = {
  'claude-opus-4-7':           { in: 5,    out: 25,  cw: 6.25,  cr: 0.5  },
  'claude-opus-4-6':           { in: 5,    out: 25,  cw: 6.25,  cr: 0.5  },
  'claude-opus-4-5':           { in: 5,    out: 25,  cw: 6.25,  cr: 0.5  },
  'claude-opus-4':             { in: 15,   out: 75,  cw: 18.75, cr: 1.5  },
  'claude-sonnet-4-6':         { in: 3,    out: 15,  cw: 3.75,  cr: 0.3  },
  'claude-haiku-4-5-20251001': { in: 1,    out: 5,   cw: 1.25,  cr: 0.1  },
  'claude-haiku-4-5':          { in: 1,    out: 5,   cw: 1.25,  cr: 0.1  },
};

// Renvoie deux coûts :
//  - full : coût API théorique (input + output + cache write + cache read) — ce que facturerait l'API
//  - plan : coût "forfait" Claude Code — exclut le cache read, qui n'est PAS facturé sur l'abonnement
function calcCost(u, model) {
  const p = PRICING[model];
  if (!p) return { full: 0, plan: 0 };
  const inT  = u.input_tokens || 0;
  const outT = u.output_tokens || 0;
  const cwT  = u.cache_creation_input_tokens || 0;
  const crT  = u.cache_read_input_tokens || 0;
  const full = (inT*p.in + outT*p.out + cwT*p.cw + crT*p.cr) / 1e6;
  const plan = (inT*p.in + outT*p.out + cwT*p.cw)            / 1e6;
  return { full, plan };
}

function loadLabels() {
  try { return JSON.parse(readFileSync(LABELS_PATH, 'utf8')); } catch { return {}; }
}

// Liste des tool_use présents dans une réponse assistant.
// Claude Code logge parfois deux fois la même réponse (même message.id) — la
// dedup sur message.id est gérée à part. Ici on extrait juste les noms.
function extractToolNames(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) if (b?.type === 'tool_use' && b.name) out.push(b.name);
  return out;
}

// Extrait un nom lisible depuis le chemin encodé du projet (cross-platform)
function projectLabel(filePath) {
  const encoded = relative(PROJECTS_ROOT, filePath).split(sep)[0];
  const parts = encoded.split('-').filter(Boolean);
  return parts[parts.length - 1] || encoded;
}

// Scan récursif de tous les .jsonl sous PROJECTS_ROOT (pour le dashboard)
function scanAllJsonl(dir, result = []) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanAllJsonl(full, result);
      else if (entry.name.endsWith('.jsonl')) result.push(full);
    }
  } catch {}
  return result;
}

// Scan uniquement les fichiers .jsonl de premier niveau (sessions parentes)
function scanSessionJsonl() {
  const sessions = [];
  try {
    for (const projDir of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!projDir.isDirectory()) continue;
      const projPath = join(PROJECTS_ROOT, projDir.name);
      try {
        for (const entry of readdirSync(projPath, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            sessions.push({ filePath: join(projPath, entry.name), projEncoded: projDir.name });
          }
        }
      } catch {}
    }
  } catch {}
  return sessions;
}

// ── DASHBOARD : parse JSONL avec filtre timestamp ─────────────────────────
async function parseJsonlSince(filePath, sinceMs) {
  const calls = [];
  const seenIds = new Set();
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const u = r.message?.usage;
      if (!u) continue;
      const mid = r.message?.id;
      if (mid) {
        if (seenIds.has(mid)) continue; // dedup : Claude Code logge parfois 2× la même réponse
        seenIds.add(mid);
      }
      const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
      if (sinceMs && ts && ts < sinceMs) continue;
      const model = r.message?.model || 'unknown';
      const c = calcCost(u, model);
      const inT = u.input_tokens || 0;
      const cwT = u.cache_creation_input_tokens || 0;
      const crT = u.cache_read_input_tokens || 0;
      calls.push({
        ts: r.timestamp || null,
        mid,
        model,
        cost: c.full,
        costPlan: c.plan,
        contextSize: inT + cwT + crT, // tokens envoyés au modèle à ce tour
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
    }
  } catch {}
  return calls;
}

async function loadHistoricalData(sinceDays = 7) {
  const sinceMs = Date.now() - sinceDays * 86400e3;
  const files = scanAllJsonl(PROJECTS_ROOT);
  console.log(`  Scanning ${files.length} JSONL files (last ${sinceDays} days)...`);
  const allCalls = [];
  const BATCH = 12;
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map(async fp => {
      try {
        if (statSync(fp).mtimeMs < sinceMs) return;
      } catch { return; }
      const proj = projectLabel(fp);
      const calls = await parseJsonlSince(fp, sinceMs);
      for (const c of calls) allCalls.push({ ...c, project: proj });
    }));
  }
  return allCalls.sort((a, b) => (!a.ts ? 1 : !b.ts ? -1 : a.ts.localeCompare(b.ts)));
}

function buildStats(calls) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayCalls = calls.filter(c => c.ts && new Date(c.ts).getTime() >= todayMs);

  const today = todayCalls.reduce((a, c) => ({
    costUSD: a.costUSD + c.cost, costPlanUSD: a.costPlanUSD + c.costPlan,
    input: a.input + c.input, output: a.output + c.output,
    cacheRead: a.cacheRead + c.cacheRead, cacheWrite: a.cacheWrite + c.cacheWrite, calls: a.calls + 1,
  }), { costUSD: 0, costPlanUSD: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

  const dailyMap = {};
  for (const c of calls) {
    if (!c.ts) continue;
    const d = c.ts.slice(0, 10);
    dailyMap[d] ??= { date: d, costUSD: 0, costPlanUSD: 0, calls: 0 };
    dailyMap[d].costUSD += c.cost; dailyMap[d].costPlanUSD += c.costPlan; dailyMap[d].calls++;
  }

  const byModel = {};
  for (const c of calls) {
    const m = c.model || 'unknown';
    byModel[m] ??= { costUSD: 0, costPlanUSD: 0, calls: 0, tokens: 0 };
    byModel[m].costUSD += c.cost; byModel[m].costPlanUSD += c.costPlan; byModel[m].calls++;
    byModel[m].tokens += c.input + c.output + c.cacheRead + c.cacheWrite;
  }

  const byProject = {};
  for (const c of calls) {
    const p = c.project || 'unknown';
    byProject[p] ??= { costUSD: 0, costPlanUSD: 0, calls: 0 };
    byProject[p].costUSD += c.cost; byProject[p].costPlanUSD += c.costPlan; byProject[p].calls++;
  }

  return {
    today,
    daily: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
    byModel, byProject,
    liveFeed: [...calls].reverse().slice(0, 50),
  };
}

// ── SESSIONS : parse complète avec titre + subagents ──────────────────────

// Parse complète d'un JSONL (sans filtre temps) — utilisé pour subagents
async function parseJsonlFull(filePath) {
  const usage = { in: 0, out: 0, cw: 0, cr: 0 };
  const byModel = {};
  const byTool = {}; // nom -> { count, in, out, cost, costPlan }
  const seenIds = new Set();
  let cost = 0, costPlan = 0, costNoCache = 0;
  let maxContext = 0, sumContext = 0, callCount = 0;
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const u = r.message?.usage;
      if (!u) continue;
      const mid = r.message?.id;
      if (mid) {
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);
      }
      const model = r.message?.model || 'unknown';
      const inT = u.input_tokens || 0, outT = u.output_tokens || 0;
      const cwT = u.cache_creation_input_tokens || 0, crT = u.cache_read_input_tokens || 0;
      const ctx = inT + cwT + crT;
      if (ctx > maxContext) maxContext = ctx;
      sumContext += ctx; callCount++;
      usage.in += inT; usage.out += outT; usage.cw += cwT; usage.cr += crT;
      byModel[model] ??= { in: 0, out: 0, cw: 0, cr: 0, cost: 0, costPlan: 0, costNoCache: 0 };
      byModel[model].in += inT; byModel[model].out += outT; byModel[model].cw += cwT; byModel[model].cr += crT;
      const p = PRICING[model];
      let cFull = 0, cPlan = 0;
      if (p) {
        cFull = (inT*p.in + outT*p.out + cwT*p.cw + crT*p.cr) / 1e6;       // API théorique
        cPlan = (inT*p.in + outT*p.out + cwT*p.cw) / 1e6;                  // Forfait Claude Code (cache read non facturé)
        const cNoC  = ((inT+cwT+crT)*p.in + outT*p.out) / 1e6;             // Si aucun cache (réf de comparaison)
        cost += cFull; costPlan += cPlan; costNoCache += cNoC;
        byModel[model].cost += cFull; byModel[model].costPlan += cPlan; byModel[model].costNoCache += cNoC;
      }
      // Attribution par tool_use du tour : split à parts égales si plusieurs tools
      const tools = extractToolNames(r.message);
      if (tools.length) {
        const n = tools.length;
        for (const tn of tools) {
          byTool[tn] ??= { count: 0, in: 0, out: 0, cw: 0, cr: 0, cost: 0, costPlan: 0 };
          byTool[tn].count++;
          byTool[tn].in       += inT  / n;
          byTool[tn].out      += outT / n;
          byTool[tn].cw       += cwT  / n;
          byTool[tn].cr       += crT  / n;
          byTool[tn].cost     += cFull / n;
          byTool[tn].costPlan += cPlan / n;
        }
      }
    }
  } catch {}
  return { usage, byModel, byTool, cost, costPlan, costNoCache, maxContext, avgContext: callCount ? sumContext / callCount : 0, callCount };
}

async function scanSubagents(sessionDir) {
  const subDir = join(sessionDir, 'subagents');
  const result = [];
  try {
    const files = readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const jsonlPath = join(subDir, f);
      const metaPath  = join(subDir, f.replace(/\.jsonl$/, '.meta.json'));
      let agentType = 'unknown', description = '';
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        agentType   = meta.agentType   || 'unknown';
        description = meta.description || '';
      } catch {}
      const parsed = await parseJsonlFull(jsonlPath);
      const dominant = Object.entries(parsed.byModel).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || 'unknown';
      result.push({ agentType, description, model: dominant, ...parsed });
    }
  } catch {}
  return result;
}

async function parseSessionFull(filePath, projEncoded) {
  const uuid = basename(filePath, '.jsonl');
  let mtime = 0;
  try { mtime = statSync(filePath).mtimeMs; } catch {}

  const usage = { in: 0, out: 0, cw: 0, cr: 0 };
  const byModel = {};
  const byTool = {};
  const seenIds = new Set();
  let cost = 0, costPlan = 0, costNoCache = 0;
  let firstPrompt = null, userTitle = null;
  let lastEventTs = 0;
  let maxContext = 0, sumContext = 0, callCount = 0;

  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }

      if (!firstPrompt && r.type === 'user' && r.message?.role === 'user') {
        const c = r.message.content;
        const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text || '').join(' ') : '';
        const expl = txt.match(/^\s*(?:<command-args>\s*)?#\s+([^\n]{2,120})/);
        if (expl) userTitle = expl[1].trim();
        const cmd = txt.match(/<command-name>(\/[^<]+)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
        if (cmd) {
          const skill = cmd[1].trim(), args = cmd[2].replace(/\s+/g, ' ').trim();
          firstPrompt = args ? `${skill} ${args}` : skill;
        } else {
          const trimmed = txt.replace(/\s+/g, ' ').trim();
          if (trimmed && !trimmed.startsWith('<command-') && !trimmed.startsWith('<local-command')) {
            firstPrompt = trimmed;
          }
        }
        if (firstPrompt) firstPrompt = firstPrompt.slice(0, 200);
      }

      if (r.timestamp) {
        const t = new Date(r.timestamp).getTime();
        if (t > lastEventTs) lastEventTs = t;
      }
      const u = r.message?.usage;
      if (!u) continue;
      const mid = r.message?.id;
      if (mid) {
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);
      }
      const model = r.message?.model || 'unknown';
      const inT = u.input_tokens || 0, outT = u.output_tokens || 0;
      const cwT = u.cache_creation_input_tokens || 0, crT = u.cache_read_input_tokens || 0;
      const ctx = inT + cwT + crT;
      if (ctx > maxContext) maxContext = ctx;
      sumContext += ctx; callCount++;
      usage.in += inT; usage.out += outT; usage.cw += cwT; usage.cr += crT;
      byModel[model] ??= { in: 0, out: 0, cw: 0, cr: 0, cost: 0, costPlan: 0, costNoCache: 0 };
      byModel[model].in += inT; byModel[model].out += outT; byModel[model].cw += cwT; byModel[model].cr += crT;
      const p = PRICING[model];
      let cFull = 0, cPlan = 0;
      if (p) {
        cFull = (inT*p.in + outT*p.out + cwT*p.cw + crT*p.cr) / 1e6;
        cPlan = (inT*p.in + outT*p.out + cwT*p.cw) / 1e6;
        const cNoC  = ((inT+cwT+crT)*p.in + outT*p.out) / 1e6;
        cost += cFull; costPlan += cPlan; costNoCache += cNoC;
        byModel[model].cost += cFull; byModel[model].costPlan += cPlan; byModel[model].costNoCache += cNoC;
      }
      const tools = extractToolNames(r.message);
      if (tools.length) {
        const n = tools.length;
        for (const tn of tools) {
          byTool[tn] ??= { count: 0, in: 0, out: 0, cw: 0, cr: 0, cost: 0, costPlan: 0 };
          byTool[tn].count++;
          byTool[tn].in       += inT  / n;
          byTool[tn].out      += outT / n;
          byTool[tn].cw       += cwT  / n;
          byTool[tn].cr       += crT  / n;
          byTool[tn].cost     += cFull / n;
          byTool[tn].costPlan += cPlan / n;
        }
      }
    }
  } catch {}

  const parentModel = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || null;

  const sessionDir = filePath.replace(/\.jsonl$/, '');
  const subagents  = await scanSubagents(sessionDir);
  for (const sa of subagents) {
    for (const k of ['in','out','cw','cr']) usage[k] += sa.usage[k];
    cost += sa.cost; costPlan += sa.costPlan; costNoCache += sa.costNoCache;
    if (sa.maxContext > maxContext) maxContext = sa.maxContext;
    sumContext += (sa.avgContext || 0) * (sa.callCount || 0);
    callCount  += (sa.callCount || 0);
    for (const [m, u] of Object.entries(sa.byModel)) {
      byModel[m] ??= { in:0, out:0, cw:0, cr:0, cost:0, costPlan:0, costNoCache:0 };
      for (const k of ['in','out','cw','cr','cost','costPlan','costNoCache']) byModel[m][k] += (u[k] || 0);
    }
    for (const [tn, t] of Object.entries(sa.byTool || {})) {
      byTool[tn] ??= { count: 0, in: 0, out: 0, cw: 0, cr: 0, cost: 0, costPlan: 0 };
      for (const k of ['count','in','out','cw','cr','cost','costPlan']) byTool[tn][k] += (t[k] || 0);
    }
  }

  // On renvoie tous les tools (pas seulement top 10) pour permettre tri client par cost/output/cw.
  // Ça reste petit en pratique (~10-30 tools max).
  const topTools = Object.entries(byTool)
    .map(([name, v]) => ({
      name, count: v.count,
      costPlan: v.costPlan, cost: v.cost,
      output:    Math.round(v.out),
      input:     Math.round(v.in),
      cacheWrite: Math.round(v.cw),
      cacheRead:  Math.round(v.cr),
    }))
    .sort((a, b) => b.costPlan - a.costPlan);

  const labels  = loadLabels();
  const project = projEncoded.split('-').filter(Boolean).pop() || projEncoded;
  const title   = labels[uuid] ? `★ ${labels[uuid]}` : (userTitle || firstPrompt || '(sans prompt user)');

  return {
    uuid, mtime, project,
    title: title.slice(0, 200),
    parentModel, usage, cost, costPlan, costNoCache,
    lastEventTs: lastEventTs || mtime,
    maxContext, avgContext: callCount ? sumContext / callCount : 0, callCount,
    total: usage.in + usage.out + usage.cw + usage.cr,
    topTools,
    subagents: subagents.map(sa => ({
      agentType:   sa.agentType,
      description: sa.description,
      model:       sa.model,
      cost:        sa.cost,
      costPlan:    sa.costPlan,
      costNoCache: sa.costNoCache,
      maxContext:  sa.maxContext,
      avgContext:  sa.avgContext,
      callCount:   sa.callCount,
      total:       sa.usage.in + sa.usage.out + sa.usage.cw + sa.usage.cr,
      usage:       sa.usage,
    })),
  };
}

// ── SESSIONS CACHE ────────────────────────────────────────────────────────
let cachedSessions = null, sessionsBuiltAt = 0, sessionsBuiltKey = '';

async function loadSessions(days = 7, project = null) {
  const key = `${days}:${project || ''}`;
  if (cachedSessions && key === sessionsBuiltKey && Date.now() - sessionsBuiltAt < 60_000) {
    return cachedSessions;
  }
  const sinceMs = Date.now() - days * 86400e3;
  const all = scanSessionJsonl()
    .filter(({ projEncoded }) => !project || projEncoded.toLowerCase().includes(project.toLowerCase()))
    .filter(({ filePath }) => { try { return statSync(filePath).mtimeMs >= sinceMs; } catch { return false; } });

  console.log(`  Parsing ${all.length} sessions (${days}d)...`);
  const results = [];
  let idx = 0;
  const CONCURRENCY = 8;
  async function worker() {
    while (idx < all.length) {
      const { filePath, projEncoded } = all[idx++];
      try { results.push(await parseSessionFull(filePath, projEncoded)); } catch {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => b.mtime - a.mtime);
  cachedSessions = results; sessionsBuiltAt = Date.now(); sessionsBuiltKey = key;
  console.log(`  Sessions: ${results.length} chargées.`);
  return results;
}

// ── LIVE SESSIONS : 3 plus récentes, avec sous-agents, sans cache long ────
let liveSessionsCache = null, liveSessionsBuiltAt = 0;
async function loadLiveSessions(limit = 3) {
  if (liveSessionsCache && Date.now() - liveSessionsBuiltAt < 5_000) return liveSessionsCache;
  const all = scanSessionJsonl().map(({ filePath, projEncoded }) => {
    let mtimeMs = 0; try { mtimeMs = statSync(filePath).mtimeMs; } catch {}
    return { filePath, projEncoded, mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);

  const results = [];
  for (const { filePath, projEncoded } of all) {
    try { results.push(await parseSessionFull(filePath, projEncoded)); } catch {}
  }
  liveSessionsCache = results; liveSessionsBuiltAt = Date.now();
  return results;
}

// ── SSE ───────────────────────────────────────────────────────────────────
const sseClients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].write(msg); } catch { sseClients.splice(i, 1); }
  }
}

// ── WATCHER ───────────────────────────────────────────────────────────────
const filePositions  = new Map(); // filePath → lastSize
const watchedFiles   = new Set();
const sessionTitles  = new Map(); // filePath → titre extrait du 1er prompt user
const seenMsgIdsLive = new Set(); // dedup global SSE (Claude Code logge parfois 2× la même réponse)
function noteLiveMsgId(id) {
  if (!id) return true;
  if (seenMsgIdsLive.has(id)) return false;
  seenMsgIdsLive.add(id);
  if (seenMsgIdsLive.size > 5000) {
    // Garde les 2500 plus récents (Set conserve l'ordre d'insertion)
    const arr = [...seenMsgIdsLive];
    seenMsgIdsLive.clear();
    for (const x of arr.slice(-2500)) seenMsgIdsLive.add(x);
  }
  return true;
}

// Lit le premier prompt user pour construire un titre de session
async function extractSessionTitle(filePath) {
  try {
    const stream = createReadStream(filePath, { end: 16384 }); // max 16KB
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== 'user' || r.message?.role !== 'user') continue;
      const c = r.message.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text || '').join(' ') : '';
      const expl = txt.match(/^\s*(?:<command-args>\s*)?#\s+([^\n]{2,80})/);
      if (expl) return expl[1].trim();
      const cmd = txt.match(/<command-name>(\/[^<]+)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (cmd) {
        const skill = cmd[1].trim(), args = cmd[2].replace(/\s+/g, ' ').trim().slice(0, 60);
        return args ? `${skill} ${args}` : skill;
      }
      const trimmed = txt.replace(/\s+/g, ' ').trim();
      if (trimmed && !trimmed.startsWith('<command-') && !trimmed.startsWith('<local-command')) {
        return trimmed.slice(0, 80);
      }
    }
  } catch {}
  return null;
}

async function readNewLines(filePath) {
  let st; try { st = statSync(filePath); } catch { return; }
  const lastSize = filePositions.get(filePath) ?? st.size;
  if (st.size <= lastSize) { filePositions.set(filePath, st.size); return; }

  const proj    = projectLabel(filePath);
  const uuid    = basename(filePath, '.jsonl');
  const stream  = createReadStream(filePath, { start: lastSize });
  filePositions.set(filePath, st.size);

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const u = r.message?.usage;
    if (!u) continue;
    const mid = r.message?.id;
    if (!noteLiveMsgId(mid)) continue; // doublon : même message.id déjà broadcasté
    const model = r.message?.model || 'unknown';
    const c = calcCost(u, model);
    const inT = u.input_tokens || 0;
    const cwT = u.cache_creation_input_tokens || 0;
    const crT = u.cache_read_input_tokens || 0;
    broadcast({
      type:         'call',
      ts:           r.timestamp || new Date().toISOString(),
      mid,
      model,
      project:      proj,
      sessionId:    uuid,
      sessionTitle: sessionTitles.get(filePath) || null,
      cost:         c.full,
      costPlan:     c.plan,
      contextSize:  inT + cwT + crT,
      input:        u.input_tokens || 0,
      output:       u.output_tokens || 0,
      cacheRead:    u.cache_read_input_tokens || 0,
      cacheWrite:   u.cache_creation_input_tokens || 0,
    });
  }
}

function startWatching(filePath) {
  if (watchedFiles.has(filePath)) return;
  watchedFiles.add(filePath);
  try { filePositions.set(filePath, statSync(filePath).size); } catch {}
  // Titre extrait de façon asynchrone, mis en cache pour les broadcasts suivants
  extractSessionTitle(filePath).then(t => { if (t) sessionTitles.set(filePath, t); }).catch(() => {});
  watchFile(filePath, { interval: 800, persistent: true }, () => {
    readNewLines(filePath).catch(() => {});
  });
}

function scanAndWatch() {
  for (const fp of scanAllJsonl(PROJECTS_ROOT)) startWatching(fp);
}

// ── STATS CACHE ───────────────────────────────────────────────────────────
let cachedStats = null, statsBuiltAt = 0;
async function getStats(days = 7) {
  if (cachedStats && Date.now() - statsBuiltAt < 30_000) return cachedStats;
  const calls = await loadHistoricalData(days);
  cachedStats = buildStats(calls);
  statsBuiltAt = Date.now();
  console.log(`  Stats: ${calls.length} appels trouvés.`);
  return cachedStats;
}

// ── HTTP SERVEUR ──────────────────────────────────────────────────────────
const HTML_PATH = join(__dirname, 'index.html');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    sseClients.push(res);
    res.write(': connected\n\n');
    const ka = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 20_000);
    req.on('close', () => { clearInterval(ka); const i = sseClients.indexOf(res); if (i >= 0) sseClients.splice(i, 1); });
    return;
  }

  if (url.pathname === '/api/stats') {
    const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await getStats(days)));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
    return;
  }

  if (url.pathname === '/api/live-sessions') {
    const limit = Math.min(10, Math.max(1, parseInt(url.searchParams.get('limit') || '3', 10)));
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await loadLiveSessions(limit)));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
    return;
  }

  if (url.pathname === '/api/sessions') {
    const days    = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
    const project = url.searchParams.get('project') || null;
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await loadSessions(days, project)));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(HTML_PATH, 'utf8'));
    } catch { res.writeHead(500); res.end('index.html introuvable'); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = 3333;
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nCCU Monitor → ${url}`);
  console.log(`Watching ~/.claude/projects/ for live token events...\n`);
  getStats(7).catch(console.error);

  const cmd = process.platform === 'win32' ? `start ${url}`
            : process.platform === 'darwin' ? `open ${url}`
            : `xdg-open ${url}`;
  exec(cmd, err => { if (err) console.log(`Ouvre manuellement : ${url}`); });
});

scanAndWatch();
setInterval(scanAndWatch, 5_000);
