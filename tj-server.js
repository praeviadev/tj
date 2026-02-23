// tj-server.js — Standalone TJ Academy Server
// Runs independently on port 3001, shares the same MySQL DB as Covenant.
// Traefik routes tj.praeviaintel.com → this container exclusively.

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { getPool, migrateTJ } = require('./db');

const PORT       = process.env.TJ_PORT || 3001;
const TJ_PASSWORD = process.env.TJ_PASSWORD || 'warrior2025';
const TJ_SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let dbPool;

// ── Utils ──────────────────────────────────────────────────────────────────

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function getSystemDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
}

function tjToken() { return crypto.randomBytes(48).toString('hex'); }

function notifyTelegram(message) {
  const webhookUrl = process.env.TELEGRAM_N8N_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const https = require('https');
    const body  = JSON.stringify({ message });
    const url   = new URL(webhookUrl);
    const req   = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.on('error', e => console.warn('[Telegram]', e.message));
    req.setTimeout(5000, () => req.destroy());
    req.write(body); req.end();
  } catch(e) { console.warn('[Telegram]', e.message); }
}

// ── Session middleware ─────────────────────────────────────────────────────

async function tjRequireSession(req, res, next) {
  const token = req.headers['x-tj-token'] || req.body?.token;
  if (!token) return res.status(401).json({ ok: false, error: 'no_token' });
  try {
    const [rows] = await dbPool.query(
      'SELECT * FROM tj_sessions WHERE token=? AND expires_at > ?',
      [token, Date.now()]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: 'session_expired' });
    req.tjSession = rows[0];
    next();
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ── State helpers ──────────────────────────────────────────────────────────

async function tjLoadState() {
  const [rows] = await dbPool.query('SELECT state_json FROM tj_state WHERE id=1');
  if (rows.length) return safeJsonParse(rows[0].state_json, {});
  const defaults = {
    gradeYear: 4,
    gradeAdvanceMonth: 9,
    xp: { total: 0, edu: 0, fit: 0, chr: 0, char: 0, resp: 0, social: 0 },
    xpToday: 0,
    todayDate: '',
    completedToday: [],
    rewardHistory: [],
    penaltyHistory: [],
    settings: { dailyGoal: 500, xpPerMin: 10, todoistProjectId: '', tjPin: '1234', parentPin: '9999' },
    xpLog: {}
  };
  await dbPool.query(
    'INSERT INTO tj_state (id, state_json, state_updated_at) VALUES (1,?,?)',
    [JSON.stringify(defaults), Date.now()]
  );
  return defaults;
}

async function tjSaveState(state) {
  state.stateUpdatedAt = Date.now();
  await dbPool.query(
    'INSERT INTO tj_state (id,state_json,state_updated_at) VALUES (1,?,?) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),state_updated_at=VALUES(state_updated_at)',
    [JSON.stringify(state), Date.now()]
  );
}

async function tjLogEvent(type, payload) {
  await dbPool.query(
    'INSERT INTO tj_events (event_type,payload_json) VALUES (?,?)',
    [type, JSON.stringify(payload)]
  );
}

function tjCheckDailyReset(state) {
  const today = getSystemDate();
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.xpToday   = 0;
    state.completedToday = [];
  }
  return state;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Serve TJ Academy frontend at root and /tj
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tj.html')));
app.get('/tj', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tj.html')));

// POST /api/tj/auth — validate access password
app.post('/api/tj/auth', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password !== TJ_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'wrong_password' });
    }
    return res.json({ ok: true, passwordAccepted: true });
  } catch(e) {
    console.error('[tj/auth]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/pin — validate PIN, issue session token
app.post('/api/tj/pin', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ ok: false, error: 'no_pin' });
    const state = await tjLoadState();
    const tjPin     = state.settings?.tjPin     || '1234';
    const parentPin = state.settings?.parentPin || '9999';
    let isParent = false;
    if      (pin === tjPin)     isParent = false;
    else if (pin === parentPin) isParent = true;
    else return res.status(401).json({ ok: false, error: 'wrong_pin' });
    const token = tjToken();
    const now   = Date.now();
    await dbPool.query('DELETE FROM tj_sessions WHERE expires_at < ?', [now]);
    await dbPool.query(
      'INSERT INTO tj_sessions (token,is_parent,created_at,expires_at) VALUES (?,?,?,?)',
      [token, isParent ? 1 : 0, now, now + TJ_SESSION_TTL]
    );
    await tjLogEvent('login', { isParent, ts: now });
    return res.json({ ok: true, token, isParent, expiresAt: now + TJ_SESSION_TTL });
  } catch(e) {
    console.error('[tj/pin]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/tj/session — validate token
app.get('/api/tj/session', tjRequireSession, (req, res) => {
  res.json({ ok: true, isParent: !!req.tjSession.is_parent, expiresAt: req.tjSession.expires_at });
});

// GET /api/tj/state — fetch full state
app.get('/api/tj/state', tjRequireSession, async (req, res) => {
  try {
    let state = await tjLoadState();
    state = tjCheckDailyReset(state);
    await tjSaveState(state);
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/state]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/xp — add or deduct XP
app.post('/api/tj/xp', tjRequireSession, async (req, res) => {
  try {
    const { amount, category, reason } = req.body || {};
    const xp  = parseInt(amount);
    if (!Number.isFinite(xp)) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    const cat = ['edu','fit','chr','char','resp','social'].includes(category) ? category : 'edu';
    let state = await tjLoadState();
    state = tjCheckDailyReset(state);
    if (xp >= 0) {
      state.xp.total   += xp;
      state.xp[cat]     = (state.xp[cat] || 0) + xp;
      state.xpToday    += xp;
      const today        = state.todayDate;
      if (!state.xpLog) state.xpLog = {};
      state.xpLog[today] = (state.xpLog[today] || 0) + xp;
    } else {
      const deduct       = Math.abs(xp);
      state.xp.total     = Math.max(0, state.xp.total - deduct);
      state.xpToday      = Math.max(0, state.xpToday  - deduct);
      state.penaltyHistory = state.penaltyHistory || [];
      state.penaltyHistory.push({ amount: deduct, reason, ts: Date.now() });
    }
    await tjSaveState(state);
    await tjLogEvent('xp', { amount: xp, category: cat, reason });
    if (process.env.TELEGRAM_N8N_WEBHOOK) {
      const sign = xp > 0 ? '+' : '';
      notifyTelegram(`⚔️ TJ: ${sign}${xp} XP — ${reason || cat}\nTotal: ${state.xp.total} XP | Today: ${state.xpToday} XP`);
    }
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/xp]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/task/complete — mark task done
app.post('/api/tj/task/complete', tjRequireSession, async (req, res) => {
  try {
    const { taskId, taskTitle, xp } = req.body || {};
    let state = await tjLoadState();
    state = tjCheckDailyReset(state);
    const id = String(taskId || taskTitle);
    if ((state.completedToday || []).includes(id)) {
      return res.json({ ok: true, deduped: true, state });
    }
    state.completedToday = state.completedToday || [];
    state.completedToday.push(id);
    const award        = parseInt(xp) || 50;
    state.xp.total    += award;
    state.xp.char      = (state.xp.char || 0) + award;
    state.xpToday     += award;
    const today        = state.todayDate;
    if (!state.xpLog) state.xpLog = {};
    state.xpLog[today] = (state.xpLog[today] || 0) + award;
    await tjSaveState(state);
    await tjLogEvent('task_complete', { taskId: id, taskTitle, xp: award });
    if (process.env.TELEGRAM_N8N_WEBHOOK) {
      notifyTelegram(`✅ TJ completed: ${taskTitle} (+${award} XP)\nToday: ${state.xpToday} XP`);
    }
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/task/complete]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/reward/claim — spend XP
app.post('/api/tj/reward/claim', tjRequireSession, async (req, res) => {
  try {
    const { rewardId, rewardName, cost } = req.body || {};
    const xpCost = parseInt(cost) || 0;
    let state = await tjLoadState();
    if (state.xp.total < xpCost) {
      return res.status(400).json({ ok: false, error: 'insufficient_xp' });
    }
    state.xp.total -= xpCost;
    state.rewardHistory = state.rewardHistory || [];
    state.rewardHistory.push({ rewardId, rewardName, cost: xpCost, ts: Date.now() });
    await tjSaveState(state);
    await tjLogEvent('reward_claimed', { rewardId, rewardName, cost: xpCost });
    if (process.env.TELEGRAM_N8N_WEBHOOK) {
      notifyTelegram(`🎮 TJ claimed: ${rewardName} (${xpCost} XP)\nBank: ${state.xp.total} XP`);
    }
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/reward/claim]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/settings — parent only
app.post('/api/tj/settings', tjRequireSession, async (req, res) => {
  try {
    if (!req.tjSession.is_parent) return res.status(403).json({ ok: false, error: 'parent_only' });
    const allowed = ['dailyGoal','xpPerMin','todoistProjectId','tjPin','parentPin'];
    let state = await tjLoadState();
    for (const key of allowed) {
      if (req.body[key] !== undefined) state.settings[key] = req.body[key];
    }
    await tjSaveState(state);
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/settings]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/penalty — parent only
app.post('/api/tj/penalty', tjRequireSession, async (req, res) => {
  try {
    if (!req.tjSession.is_parent) return res.status(403).json({ ok: false, error: 'parent_only' });
    const { amount, reason } = req.body || {};
    const deduct = Math.abs(parseInt(amount) || 0);
    if (!deduct) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    let state = await tjLoadState();
    state = tjCheckDailyReset(state);
    state.xp.total       = Math.max(0, state.xp.total - deduct);
    state.xpToday        = Math.max(0, state.xpToday  - deduct);
    state.penaltyHistory = state.penaltyHistory || [];
    state.penaltyHistory.push({ amount: deduct, reason, ts: Date.now() });
    await tjSaveState(state);
    await tjLogEvent('penalty', { amount: deduct, reason });
    if (process.env.TELEGRAM_N8N_WEBHOOK) {
      notifyTelegram(`⚠️ TJ penalty: -${deduct} XP — ${reason}\nTotal: ${state.xp.total} XP`);
    }
    res.json({ ok: true, state });
  } catch(e) {
    console.error('[tj/penalty]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/tj/log — client error logging
app.post('/api/tj/log', async (req, res) => {
  try {
    const { event, payload } = req.body || {};
    await tjLogEvent(event || 'client_log', payload || {});
    if (event?.includes('error') && process.env.TJ_LOG_WEBHOOK) {
      const https = require('https');
      // fire and forget
      fetch(process.env.TJ_LOG_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'tj_academy', event, payload, ts: new Date().toISOString() })
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'tj-academy' }));

// ── Boot ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    const { getPool, migrateTJ } = require('./db');
    dbPool = getPool();
    await migrateTJ(dbPool);
    console.log('[TJ] DB tables ready');
    app.listen(PORT, () => console.log(`[TJ] Academy running on port ${PORT}`));
  } catch(e) {
    console.error('[TJ] Boot failed:', e.message);
    process.exit(1);
  }
}

start();
