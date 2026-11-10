require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const db = new Database(process.env.DB_PATH || './guardrails.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    expected_interval_minutes INTEGER NOT NULL DEFAULT 60,
    spend_limit_usd REAL,
    killed INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at TEXT,
    spend_this_period_usd REAL NOT NULL DEFAULT 0,
    period_started_at TEXT
  );
  CREATE TABLE IF NOT EXISTS alerts_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

async function sendAlert(workflowId, type, message) {
  db.prepare(
    'INSERT INTO alerts_log (workflow_id, type, message, created_at) VALUES (?, ?, ?, ?)'
  ).run(workflowId, type, message, new Date().toISOString());

  if (!process.env.SLACK_WEBHOOK_URL) return;

  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `[${type}] ${workflowId}: ${message}` })
  }).catch((err) => console.error('Slack alert failed', err.message));
}

// Register or update a workflow's monitoring config.
app.put('/workflows/:id', (req, res) => {
  const { name, platform, expected_interval_minutes, spend_limit_usd } = req.body;
  db.prepare(`
    INSERT INTO workflows (id, name, platform, expected_interval_minutes, spend_limit_usd, period_started_at)
    VALUES (@id, @name, @platform, @interval, @limit, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, platform = @platform,
      expected_interval_minutes = @interval, spend_limit_usd = @limit
  `).run({
    id: req.params.id,
    name,
    platform,
    interval: expected_interval_minutes || 60,
    limit: spend_limit_usd ?? null,
    now: new Date().toISOString()
  });
  res.json({ ok: true });
});

// Call this as the first step of every workflow run.
app.post('/heartbeat/:id', (req, res) => {
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'unknown workflow, register it first' });

  db.prepare('UPDATE workflows SET last_heartbeat_at = ? WHERE id = ?')
    .run(new Date().toISOString(), req.params.id);

  res.json({ ok: true, killed: !!wf.killed });
});

// Call this after any step that burns paid API credits.
app.post('/spend/:id', (req, res) => {
  const { amount_usd } = req.body;
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'unknown workflow, register it first' });

  const newSpend = wf.spend_this_period_usd + Number(amount_usd || 0);
  db.prepare('UPDATE workflows SET spend_this_period_usd = ? WHERE id = ?')
    .run(newSpend, req.params.id);

  if (wf.spend_limit_usd && newSpend >= wf.spend_limit_usd) {
    db.prepare('UPDATE workflows SET killed = 1 WHERE id = ?').run(req.params.id);
    sendAlert(
      req.params.id,
      'SPEND_LIMIT',
      `Spend hit $${newSpend.toFixed(2)} of $${wf.spend_limit_usd} limit. Kill switch engaged.`
    );
  }

  res.json({ ok: true, spend_this_period_usd: newSpend });
});

// Workflows should call this before any paid or risky step.
app.get('/kill-switch/:id', (req, res) => {
  const wf = db.prepare('SELECT killed FROM workflows WHERE id = ?').get(req.params.id);
  res.json({ killed: wf ? !!wf.killed : false });
});

// Manually engage or release the kill switch for a workflow.
app.post('/kill-switch/:id', (req, res) => {
  const { killed } = req.body;
  db.prepare('UPDATE workflows SET killed = ? WHERE id = ?').run(killed ? 1 : 0, req.params.id);
  res.json({ ok: true, killed: !!killed });
});

// Every 5 minutes, flag workflows that missed their expected heartbeat.
// A 2x grace multiplier absorbs normal run jitter without hiding real outages.
cron.schedule('*/5 * * * *', () => {
  const workflows = db.prepare('SELECT * FROM workflows WHERE killed = 0').all();
  const now = Date.now();

  for (const wf of workflows) {
    if (!wf.last_heartbeat_at) continue;
    const minutesSince = (now - new Date(wf.last_heartbeat_at).getTime()) / 60000;
    if (minutesSince > wf.expected_interval_minutes * 2) {
      sendAlert(
        wf.id,
        'MISSED_HEARTBEAT',
        `No heartbeat in ${Math.round(minutesSince)} minutes (expected every ${wf.expected_interval_minutes}).`
      );
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Guardrails listening on :${port}`));
