# TJ Academy — Full Deployment Checklist

## Files to Deploy
All five files need to be placed in your Covenant project directory (same folder as your current `server.js`):

| File | What Changed |
|------|-------------|
| `server.js` | Added 9 new `/api/tj/...` routes + `/tj` static route |
| `db.js` | Added `tj_state`, `tj_sessions`, `tj_events` tables + `migrateTJ()` |
| `tj.html` | TJ's full frontend app |
| `Dockerfile` | Added `tj.html` to both build stages |
| `docker-compose.yml` | Added `tj.praeviaintel.com` Traefik router |

---

## Step 1 — DNS

Create an A record for `tj.praeviaintel.com` pointing to your server's IP address.  
This is the same IP as `covenant.praeviaintel.com`.

**Verify with:**
```bash
dig tj.praeviaintel.com +short
# Should return your server IP
```

DNS propagation can take a few minutes to a few hours. Don't proceed to SSL until this resolves.

---

## Step 2 — Environment Variables

On your server, open the `.env` file in your Covenant project directory and add these two lines:

```env
TJ_PASSWORD=choose_a_strong_password_here
TJ_LOG_WEBHOOK=https://n8n.praeviaintel.com/webhook/YOUR_LOGGING_WEBHOOK_ID
```

**Existing vars that TJ also uses (verify these are already set):**
```env
TELEGRAM_N8N_WEBHOOK=https://n8n.praeviaintel.com/webhook/d53b7f16-18ce-40e1-a4c6-54dc37eb1d95
DB_HOST=...
DB_PORT=3306
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
SESSION_SECRET=...
TZ=America/New_York
```

`TJ_PASSWORD` is the password TJ (or you) enters on the web access screen. Set it to something TJ can remember but that isn't trivially guessable. The default fallback is `warrior2025` but **do not rely on the default in production**.

`TJ_LOG_WEBHOOK` should point to your existing n8n `logging` workflow webhook. All client-side errors from TJ's app will POST there with `{ app: "tj_academy", event: "error_...", payload: {...} }`.

---

## Step 3 — Deploy Files to Server

Copy all five files to your project directory:

```bash
# From your local machine
scp server.js db.js tj.html Dockerfile docker-compose.yml user@yourserver:/path/to/covenant/
```

Or if you use git:
```bash
git add server.js db.js tj.html Dockerfile docker-compose.yml
git commit -m "feat: TJ Academy backend + frontend"
git push
# then on server: git pull
```

---

## Step 4 — Rebuild and Restart the Container

```bash
cd /path/to/covenant

# Rebuild the image (required — Dockerfile changed)
docker compose build --no-cache

# Bring it back up
docker compose up -d

# Verify it started cleanly
docker compose logs -f covenant
```

Watch the logs for:
```
✓ DB connected
✓ tj_state table created (or already exists)
✓ tj_sessions table created (or already exists)
✓ tj_events table created (or already exists)
Server listening on port 3000
```

If you see any migration errors, check your DB credentials in `.env`.

---

## Step 5 — Verify SSL Certificate

Traefik will automatically request a Let's Encrypt certificate for `tj.praeviaintel.com` on first connection. This requires port 443 to be open and DNS to be resolving.

```bash
# Check Traefik logs for cert issuance
docker logs traefik 2>&1 | grep tj.praeviaintel
```

You should see something like:
```
Certificates obtained for domains: [tj.praeviaintel.com]
```

If you see ACME errors, DNS hasn't propagated yet. Wait and retry.

---

## Step 6 — Test the Server Endpoints

Run these from your server (or any machine) to verify the API is live before touching the app:

```bash
BASE="https://tj.praeviaintel.com"

# 1. Test password auth
curl -s -X POST $BASE/api/tj/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"your_tj_password"}' | jq .
# Expected: {"ok":true,"passwordAccepted":true}

# 2. Test wrong password
curl -s -X POST $BASE/api/tj/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"wrong"}' | jq .
# Expected: {"ok":false,"error":"wrong_password"}

# 3. Test PIN (default TJ PIN is 1234 until changed)
curl -s -X POST $BASE/api/tj/pin \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}' | jq .
# Expected: {"ok":true,"token":"...long hex...","isParent":false,"expiresAt":...}

# 4. Save the token and test state load
TOKEN=$(curl -s -X POST $BASE/api/tj/pin \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}' | jq -r .token)

curl -s $BASE/api/tj/state \
  -H "x-tj-token: $TOKEN" | jq .state.gradeYear
# Expected: 4

# 5. Test XP award
curl -s -X POST $BASE/api/tj/xp \
  -H "Content-Type: application/json" \
  -H "x-tj-token: $TOKEN" \
  -d '{"amount":50,"category":"edu","reason":"deployment test"}' | jq .state.xp.total
# Expected: 50

# 6. Verify it persisted (new request, same token)
curl -s $BASE/api/tj/state \
  -H "x-tj-token: $TOKEN" | jq .state.xp.total
# Expected: 50 (not 0 — proves MySQL is writing correctly)

# 7. Test the app loads
curl -s -o /dev/null -w "%{http_code}" $BASE/tj
# Expected: 200
```

If step 6 returns 50, your database persistence is working correctly. If it returns 0, the DB write is failing silently — check logs.

---

## Step 7 — Import n8n Workflow

1. Open `https://n8n.praeviaintel.com`
2. Go to **Workflows** → click the workflow you want to update (or create new)
3. Click the **⋮ menu** → **Import from file**
4. Select `covenant_dev.json`
5. Click **Save**
6. Toggle the workflow to **Active** (top right)

**Verify the TJ Oracle webhook is live:**
```bash
curl -s -X POST https://n8n.praeviaintel.com/webhook/b7c8d9e0-f1a2-3456-bcde-f01234567890 \
  -H "Content-Type: application/json" \
  -d '{"action":"tj_quiz","subject":"math","grade":4,"type":"math","count":3}' | jq .
# Expected: {"output": [...array of 3 questions...]}
```

If this returns a 404, the workflow isn't active. If it returns an empty response, check n8n execution logs for the `TJ Oracle` node.

---

## Step 8 — Wire Output Parsers in n8n (Manual Step)

n8n does not auto-connect sub-nodes on JSON import. You must do this by hand on the canvas:

1. Find **AI Agent: TJ Quiz** on the canvas
2. Drag the output of **Parser: TJ Quiz** into the **Output Parser** slot (the `<>` icon on the bottom right of the agent node)
3. Drag the output of **OpenRouter: TJ Quiz** into the **Language Model** slot
4. Repeat for **AI Agent: TJ Fitness**:
   - **Parser: TJ Fitness** → Output Parser slot
   - **OpenRouter: TJ Fitness** → Language Model slot
5. Click **Save** → verify workflow is still **Active**

---

## Step 9 — Configure the App (Parent Settings)

1. Open `https://tj.praeviaintel.com/tj` in a browser
2. Enter the access password you set in `.env` as `TJ_PASSWORD`
3. Enter the **Parent PIN** (default: `9999`)
4. You'll land on the **⚙️ Parent** tab automatically
5. Fill in:

| Setting | Value |
|---------|-------|
| **n8n Oracle Webhook** | `https://n8n.praeviaintel.com/webhook/b7c8d9e0-f1a2-3456-bcde-f01234567890` |
| **n8n Todoist Webhook** | Your n8n webhook that fetches TJ's Todoist tasks |
| **n8n Logging Webhook** | Same as `TJ_LOG_WEBHOOK` in your `.env` |
| **Todoist Project ID** | The ID of TJ's project in your praeviamail.com Todoist account |
| **Daily XP Goal** | 500 (adjust as needed) |
| **XP per Minute** | 10 (screen time: 500 XP ÷ 10 = 50 min unlocked) |

6. Change **TJ's PIN** from `1234` to something he'll remember but can't guess from this doc
7. Change **Parent PIN** from `9999` to something secure

**To find your Todoist Project ID:**
- Open Todoist → right-click TJ's project → **Project Settings**
- The URL will contain the ID: `todoist.com/app/project/XXXXXXXXX`

---

## Step 10 — Build TJ's Todoist n8n Webhook

TJ's app calls your `todoistHook` with:
```json
{ "action": "get_tj_tasks", "projectId": "YOUR_PROJECT_ID" }
```

You need an n8n webhook that responds with:
```json
{
  "tasks": [
    { "id": "123", "content": "Read for 20 minutes (50 XP)", "xp": 50 },
    { "id": "456", "content": "Practice multiplication tables (75 XP)", "xp": 75 }
  ]
}
```

The XP per task is extracted from the task title using `(N XP)` notation — same pattern as your Covenant Todoist integration. Build this as a new webhook branch in your covenant n8n workflow:

```
New Webhook (TJ Tasks)
  → HTTP Request: GET https://api.todoist.com/rest/v2/tasks?project_id={{ $json.body.projectId }}
    (use Todoist API credential, same as your reminder flow)
  → Code node: map tasks to { id, content, xp } — extract XP from title with regex
  → Respond to Webhook
```

---

## Step 11 — End-to-End Smoke Test

Run through this full flow manually:

1. **Auth flow**: Open `tj.praeviaintel.com/tj` → enter password → enter TJ PIN → land on Home
2. **State persistence**: Note the XP total → refresh the page → re-enter PIN → XP total should be the same
3. **Quiz**: Tap Learn → tap Math → questions load from n8n → answer one correctly → XP increases on server (not just UI)
4. **Task complete**: Tap a daily mission → check XP increases → reload and confirm it persisted
5. **Telegram**: Complete a quiz — you should receive a Telegram message within seconds
6. **Penalty**: Log in as parent → issue a penalty → confirm XP deducts → Telegram fires
7. **Reward**: Earn enough XP → Rewards tab → claim a reward → confirm XP deducted from server state
8. **Session expiry simulation**: Delete `tj_token_v1` from browser localStorage → reload → should redirect to password screen
9. **Wrong password**: Enter wrong password → should show error, not proceed
10. **Wrong PIN**: Enter wrong PIN → should show error, not proceed

---

## Step 12 — Set Up Grade Auto-Advance

TJ is currently in 4th grade. The app will automatically advance him to 5th grade on September 1st. No action required — this is handled server-side in `tjCheckDailyReset()` which is called on every state load.

To verify the advance logic is correct:
```bash
# Check current grade in DB
TOKEN=$(curl -s -X POST https://tj.praeviaintel.com/api/tj/pin \
  -H "Content-Type: application/json" \
  -d '{"pin":"YOUR_TJ_PIN"}' | jq -r .token)

curl -s https://tj.praeviaintel.com/api/tj/state \
  -H "x-tj-token: $TOKEN" | jq '{grade: .state.gradeYear, advanceMonth: .state.gradeAdvanceMonth}'
# Expected: {"grade": 4, "advanceMonth": 9}
```

---

## Rollback Plan

If something goes wrong after deploy:

```bash
# Revert to previous image (if you tagged it)
docker compose down
docker tag covenant:previous covenant:latest
docker compose up -d

# Or restore from git
git checkout HEAD~1 -- server.js db.js Dockerfile docker-compose.yml
docker compose build --no-cache && docker compose up -d
```

The new `tj_state`, `tj_sessions`, and `tj_events` tables are additive — rolling back the code will not break Covenant. The tables will just sit unused.

---

## Quick Reference

| Item | Value |
|------|-------|
| TJ App URL | `https://tj.praeviaintel.com/tj` |
| TJ Oracle Webhook | `https://n8n.praeviaintel.com/webhook/b7c8d9e0-f1a2-3456-bcde-f01234567890` |
| Default TJ PIN | `1234` (change immediately) |
| Default Parent PIN | `9999` (change immediately) |
| Default Access Password | set via `TJ_PASSWORD` in `.env` |
| Session TTL | 7 days (refreshes on every PIN entry) |
| Grade | 4th → auto-advances to 5th on Sept 1 |
| DB Tables Added | `tj_state`, `tj_sessions`, `tj_events` |
