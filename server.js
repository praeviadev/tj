const express = require('express');
const http = require('http'); // Required for Socket.io
const { Server } = require('socket.io'); // WebSocket Server
const path = require('path');
const session = require('express-session');
const cron = require('node-cron'); // The Scheduler
const multer = require('multer'); // File Uploads
const { parse } = require('csv-parse/sync'); // CSV Parser
const { getPool, migrate } = require('./db');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const AUTH_PASSWORD = process.env.COVENANT_PASSWORD || 'THAN-36XDarnell';
const upload = multer({ storage: multer.memoryStorage() }); // Handle CSVs in memory

// --- APP INIT ---
const app = express();
const server = http.createServer(app); // Wrap Express
const io = new Server(server); // Attach Socket.io

let dbPool;

// --- UTILS ---
// Helper: Get 'YYYY-MM-DD' in the system's configured timezone (NY)
function getSystemDate() {
    // 'en-CA' format is always YYYY-MM-DD
    return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
}

function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

// --- TELEGRAM NOTIFY ---
function notifyTelegram(message) {
    const webhookUrl = process.env.TELEGRAM_N8N_WEBHOOK;
    if (!webhookUrl) return;
    try {
        const https = require('https');
        const body = JSON.stringify({ message });
        const url = new URL(webhookUrl);
        const req = https.request({
            hostname: url.hostname, path: url.pathname + url.search,
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, () => {});
        req.on('error', e => console.warn('[Telegram] notify failed:', e.message));
        req.setTimeout(5000, () => req.destroy());
        req.write(body); req.end();
    } catch (e) { console.warn('[Telegram] notify error:', e.message); }
}

// Pass { xpDelta, xpReason } to trigger Telegram notification.
async function saveAndBroadcastState(newState, { xpDelta = null, xpReason = null } = {}) {
    const now = Date.now();
    newState.stateUpdatedAt = now;

    await dbPool.query(
        'INSERT INTO covenant_state (id, state_json, state_updated_at) VALUES (1, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE state_json=VALUES(state_json), state_updated_at=VALUES(state_updated_at)',
        [JSON.stringify(newState), now]
    );

    io.emit('state_update', newState);

    if (xpDelta !== null && xpDelta !== 0 && process.env.TELEGRAM_N8N_WEBHOOK) {
        const sign = xpDelta > 0 ? '+' : '';
        const total = newState.xp ?? '?';
        const reason = xpReason ? ` — ${xpReason}` : '';
        notifyTelegram(`⚔️ *Covenant XP Update*\n${sign}${xpDelta} XP${reason}\n*Total: ${total} XP*`);
    }

    return newState;
}

// --- MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'covenant-v2-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24*60*60*1000 }
});
app.use(sessionMiddleware);

// Share session with Socket.io (optional, for auth checks on sockets)
io.engine.use(sessionMiddleware);

// --- AUTH GATES ---
const requireAuth = (req, res, next) => req.session.authenticated ? next() : res.redirect('/login');
const requireAuthApi = (req, res, next) => req.session.authenticated ? next() : res.status(401).json({ error: 'unauthorized' });

// --- CRON JOBS (THE AUTOMATION) ---

// COV-02: Hourly decay removed

// MIDNIGHT — reset counters + daily floor miss (COV-02, COV-04)
cron.schedule('59 23 * * *', async () => {
    console.log('[CRON] Midnight...');
    const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
    if (!rows.length) return;
    let state = safeJsonParse(rows[0].state_json, {});

    // COV-04: penalty only if earned XP < floor
    const todayKey = getSystemDate();
    const todayEarned = parseInt((state.xpLog && state.xpLog[todayKey]) || 0);
    const GOAL_MISS_PENALTY = parseInt(process.env.GOAL_MISS_PENALTY || '500');
    const GOAL_MIN_FLOOR    = parseInt(process.env.GOAL_MIN_FLOOR    || '100');

    if (todayEarned < GOAL_MIN_FLOOR) {
        state.xp = Math.max(0, (state.xp || 0) - GOAL_MISS_PENALTY);
        if (!state.xpLog) state.xpLog = {};
        state.xpLog[todayKey] = (parseInt(state.xpLog[todayKey] || 0) - GOAL_MISS_PENALTY);
        console.log(`[CRON] Floor miss: ${todayEarned} XP. -${GOAL_MISS_PENALTY} XP.`);
        io.emit('notification', { type: 'danger', message: `DAILY FLOOR MISSED: ${todayEarned} XP earned. -${GOAL_MISS_PENALTY} XP.` });
        await saveAndBroadcastState(state, { xpDelta: -GOAL_MISS_PENALTY, xpReason: `Daily floor missed (${todayEarned} XP earned)` });
    } else {
        state.daily_prayer_count = 0;
        await saveAndBroadcastState(state);
    }
    console.log('[CRON] Midnight complete.');
});

// --- API ROUTES ---

// Login
app.post('/login', (req, res) => {
    if (req.body.password === AUTH_PASSWORD) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// State Management (GET)
app.get('/api/state', requireAuthApi, async (req, res) => {
    try {
        const [rows] = await dbPool.query('SELECT state_json, state_updated_at FROM covenant_state WHERE id=1');
        if (!rows.length) return res.json({ ok: true, state: null, stateUpdatedAt: null });
        return res.json({ ok: true, state: safeJsonParse(rows[0].state_json, null), stateUpdatedAt: rows[0].state_updated_at });
    } catch (err) { return res.status(500).json({ ok: false, error: 'db_error' }); }
});

// State Management (POST - Manual Sync from Client)
app.post('/api/state', requireAuthApi, async (req, res) => {
    try {
        const newState = req.body;
        const rawTs = newState?.stateUpdatedAt;
        if (rawTs === undefined || rawTs === null) return res.status(400).json({ ok: false, error: 'missing_stateUpdatedAt' });
        const incomingTs = Number(rawTs);
        if (!Number.isFinite(incomingTs) || incomingTs <= 0) return res.status(400).json({ ok: false, error: 'invalid_stateUpdatedAt' });
        const [rows] = await dbPool.query('SELECT state_updated_at FROM covenant_state WHERE id=1');
        const currentTs = rows?.[0]?.state_updated_at != null ? Number(rows[0].state_updated_at) : null;
        if (currentTs !== null && incomingTs < currentTs) return res.status(409).json({ ok: false, error: 'stale_state', currentStateUpdatedAt: currentTs });
        await saveAndBroadcastState(newState);
        res.json({ ok: true, stateUpdatedAt: newState.stateUpdatedAt });
    } catch (err) { return res.status(500).json({ ok: false, error: 'db_error' }); }
});

// Event Logger & State Mutator
app.post('/api/event', requireAuthApi, async (req, res) => {
    const { type, payload } = req.body;
    
    // Fetch current state
    const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
    let state = safeJsonParse(rows[0].state_json, {});

    // --- LOGIC HOOKS (SERVER SIDE AUTHORITY) ---
    
    // 1. Prayer Log: Count it
    if (type === 'prayer_log') {
        state.daily_prayer_count = (state.daily_prayer_count || 0) + 1;
    }
    
    // 2. Temple Liturgy: Toggle the checkbox in state
    if (type === 'temple_liturgy') {
        // Fallback to server time if client didn't send date
        const targetDate = payload.date || getSystemDate(); 
        
        if (!state.temple_log) state.temple_log = {};
        if (!state.temple_log[targetDate]) state.temple_log[targetDate] = {};
        
        const currentVal = state.temple_log[targetDate][payload.item];
        state.temple_log[targetDate][payload.item] = !currentVal;
    }

    // 3. Task Complete: Award XP (Security: Move logic to server eventually)
    if (type === 'task_complete') {
        // Simple server-side validation could go here
        // For now, we trust the client's separate state update or handle it here if we want
        // Current client implementation handles XP calc client-side and sends state push.
        // We will leave this passive for now to avoid conflict.
    }

    // --- PERSISTENCE ---
    await dbPool.query('INSERT INTO covenant_events (event_type, payload_json) VALUES (?, ?)', [type, JSON.stringify(payload)]);

    let xpDelta = null, xpReason = null;
    if (type === 'xp_add' && payload && typeof payload.amount === 'number' && payload.amount !== 0) {
        xpDelta = payload.amount;
        const reasonMap = { 'prayer_complete':'Prayer','quiz_complete':'Quiz','meditation':'Meditation','service':'Selfless Service','temptation_victory':'Temptation Victory','household_task':'Household Task','counsel':'Household Counsel','praevia':'Praevia Action','career':'Career Archive','food_log':'Food Log','exercise_log':'Exercise Log' };
        xpReason = reasonMap[payload.source] || 'In-App Action';
    }

    await saveAndBroadcastState(state, xpDelta !== null ? { xpDelta, xpReason } : {});
    res.json({ ok: true });
});

// --- XP AUTHORITY ENDPOINT ---
app.post('/api/xp', requireAuthApi, async (req, res) => {
    try {
        const { amount, source, streakDate } = req.body;
        const delta = Number(amount);
        if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });

        const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
        let state = rows.length ? safeJsonParse(rows[0].state_json, {}) : {};

        state.xp = Math.max(0, (state.xp || 0) + delta);
        state.lastActivity = Date.now();

        const todayKey = getSystemDate();
        if (!state.xpLog) state.xpLog = {};
        state.xpLog[todayKey] = (parseInt(state.xpLog[todayKey] || 0) + delta);

        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
        const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
        Object.keys(state.xpLog).forEach(k => { if (k < cutoffStr) delete state.xpLog[k]; });

        if (streakDate) {
            const prevStreak = state.lastStreakDate || '';
            const yesterday = new Date(Date.now() - 86400000).toDateString();
            if (prevStreak === yesterday) { state.streak = (state.streak || 0) + 1; state.lastStreakDate = streakDate; }
            else if (prevStreak !== streakDate) { state.streak = 1; state.lastStreakDate = streakDate; }
        }

        await dbPool.query('INSERT INTO covenant_events (event_type, payload_json) VALUES (?, ?)', ['xp_add', JSON.stringify({ amount: delta, source, xp: state.xp })]);

        const reasonMap = { 'prayer_complete':'Prayer','quiz_complete':'Quiz','meditation':'Meditation','service':'Selfless Service','temptation_victory':'Temptation Victory','household_task':'Household Task','counsel':'Household Counsel','praevia':'Praevia Action','career':'Career Archive','food_log':'Food Log','exercise_log':'Exercise Log' };
        await saveAndBroadcastState(state, { xpDelta: delta, xpReason: reasonMap[source] || 'In-App Action' });

        return res.json({ ok: true, xp: state.xp, streak: state.streak });
    } catch (e) { console.error('[/api/xp] error:', e); return res.status(500).json({ ok: false, error: e.message }); }
});

// --- CONFIGURATION & RESTORATION ---

// Update System Config (N8N URL)
app.post('/api/config', requireAuthApi, async (req, res) => {
    const { n8n_url } = req.body;
    
    const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
    let state = safeJsonParse(rows[0].state_json, {});
    
    // Initialize config object if missing
    if (!state.config) state.config = {};
    
    // Update URL (strip trailing slash for consistency)
    if (n8n_url) state.config.n8n_url = n8n_url.replace(/\/$/, "");
    
    await saveAndBroadcastState(state);
    res.json({ ok: true });
});

// Robust Legacy CSV Restoration
app.post('/api/restore-legacy', requireAuthApi, upload.single('csv'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        
        // robust parser: looser rules, trims whitespace
        const records = parse(req.file.buffer, { 
            columns: true, 
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true 
        });
        
        const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
        let state = safeJsonParse(rows[0].state_json, {});
        
        let restoredXP = 0;
        let restoredStreak = 0;
        let logsFound = 0;

        // "Smart Scan": Look for relevant data in ANY row
        records.forEach(row => {
            // Case A: It's a history log (summing up XP)
            if (row.xp_award || row.xp) {
                const val = parseInt(row.xp_award || row.xp);
                if (!isNaN(val)) restoredXP += val;
            }
            // Case B: It's a state dump (taking the max value found)
            if (row.total_xp) {
                const val = parseInt(row.total_xp);
                if (!isNaN(val) && val > restoredXP) restoredXP = val;
            }
            if (row.streak) {
                const val = parseInt(row.streak);
                if (!isNaN(val) && val > restoredStreak) restoredStreak = val;
            }
            logsFound++;
        });

        // Apply changes if data found
        if (restoredXP > 0) state.xp = (state.xp || 0) + restoredXP;
        if (restoredStreak > 0) state.streak = Math.max((state.streak || 0), restoredStreak);

        await saveAndBroadcastState(state);
        
        console.log(`[Restoration] Processed ${logsFound} rows. Added ${restoredXP} XP.`);
        res.json({ ok: true, message: `Scanned ${logsFound} rows. XP Updated: +${restoredXP}` });

    } catch (e) {
        console.error("CSV Import Error:", e);
        res.status(500).json({ error: 'Import failed: ' + e.message });
    }
});

// --- SERVE FRONTEND ---

// 1. Serve Static Assets (images, styles) - Public
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// 2. Serve Login Page - Public
app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// --- EXTERNAL WEBHOOKS (NO SESSION; KEY-PROTECTED) ---
const EXTERNAL_SYNC_KEY = process.env.EXTERNAL_SYNC_KEY || 'covenant-sync-88';

/**
 * n8n -> Covenant
 * Body example:
 * {
 *   "key": "covenant-sync-88",
 *   "taskTitle": "Take out trash for Wednesday pickup",
 *   "xpAward": 50,
 *   "externalId": "todoist:1234567890:completed_at:2026-02-08T12:34:56Z"
 * }
 */
app.post('/api/external/todoist-complete', async (req, res) => {
  try {
    const { key, taskTitle, xpAward, externalId } = req.body || {};

    // 1) Auth
    if (!key || key !== EXTERNAL_SYNC_KEY) {
      return res.status(401).json({ ok: false, error: 'invalid_key' });
    }

    // 2) Validate
    const award = Number(xpAward);
    if (!taskTitle || !Number.isFinite(award)) {
      return res.status(400).json({ ok: false, error: 'missing_taskTitle_or_xpAward' });
    }

    // 3) Load current state
    const [rows] = await dbPool.query('SELECT state_json FROM covenant_state WHERE id=1');
    let state = rows.length ? safeJsonParse(rows[0].state_json, {}) : {};
    if (!state.xp) state.xp = 0;

    // 4) Simple idempotency (prevents double-award if n8n retries)
    // Stores a small rolling cache in state.external_awards
    if (!state.external_awards) state.external_awards = {};
    const id = String(externalId || `todoist:${taskTitle}:${new Date().toISOString().slice(0, 10)}`);

    if (state.external_awards[id]) {
      return res.json({ ok: true, deduped: true, xp: state.xp });
    }

    // 5) Apply XP (positive only here; if you want negatives, allow award < 0)
    state.xp = Math.max(0, state.xp + award);
    state.external_awards[id] = { taskTitle, xpAward: award, ts: Date.now() };

    // Keep cache from growing forever (optional)
    const keys = Object.keys(state.external_awards);
    if (keys.length > 500) {
      // delete oldest ~100
      const sorted = keys
        .map(k => ({ k, ts: state.external_awards[k]?.ts || 0 }))
        .sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < 100; i++) delete state.external_awards[sorted[i].k];
    }

    // 6) Log the event in DB (keeps history)
    await dbPool.query(
      'INSERT INTO covenant_events (event_type, payload_json) VALUES (?, ?)',
      ['todoist_complete', JSON.stringify({ taskTitle, xpAward: award, externalId: id })]
    );

    // 6b) Write to xpLog so performance meter reflects it
    if (award > 0) {
        const todayKey = getSystemDate();
        if (!state.xpLog) state.xpLog = {};
        state.xpLog[todayKey] = (parseInt(state.xpLog[todayKey] || 0) + award);
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
        const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
        Object.keys(state.xpLog).forEach(k => { if (k < cutoffStr) delete state.xpLog[k]; });
    }

    // 7) Persist + broadcast + Telegram
    await saveAndBroadcastState(state, { xpDelta: award, xpReason: `Todoist: ${taskTitle}` });
    io.emit('notification', {
      type: 'success',
      message: `TODOIST COMPLETE: +${award} XP — ${taskTitle}`
    });

    return res.json({ ok: true, xp: state.xp });
  } catch (e) {
    console.error('[todoist-complete] error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});



// 3. Serve App - PROTECTED
// Only serve index.html for HTML navigation requests.
// Asset 404s return a real 404 — not index.html — to prevent "Unexpected token '<'" JS errors.
app.get('*', requireAuth, (req, res) => {
    if (!req.session.authenticated) return res.redirect('/login');
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (!acceptsHtml) return res.status(404).send('Not found');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WEBSOCKETS (Socket.io) ---
io.on('connection', (socket) => {
    console.log('[Socket] Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('[Socket] Client disconnected');
    });
});

// --- BOOT ---


async function start() {
    try {
        dbPool = getPool();
        await migrate(dbPool);
        console.log('[DB] MariaDB Connected & Migrated.');
        
        server.listen(PORT, () => {
            console.log(`[System] Benjamin Covenant Protocol v2.0 Online on Port ${PORT}`);
        });
    } catch (err) {
        console.error('[Fatal] Boot failed:', err);
    }
}

start();