# Automation Health Guardrails

> Built by [Avalux](https://avalux.io), a full-stack AI automation agency. This repo is open source under MIT and lives at [github.com/elikem2021/automation-health-guardrails](https://github.com/elikem2021/automation-health-guardrails). See more of our open source work at [github.com/elikem2021/avalux-open-source](https://github.com/elikem2021/avalux-open-source).

Find out an automation broke before the client calls you about it.

If you build and maintain automations on n8n, Make, or Zapier for clients, you already know the failure mode. A workflow runs fine for three months, then a vendor API changes a field name, an auth token expires, or a rate limit kicks in, and the workflow just stops. Nobody notices until the client emails asking why no leads showed up last week, or why their invoice sync has been broken since the 12th. The other version of this problem is worse: a workflow keeps running, but something in a loop condition is wrong, so it calls an expensive API endpoint ten thousand times instead of ten, and you find out when the OpenAI or Twilio bill lands.

This toolkit is a small, self-hosted service that sits next to your automations and watches for both failure modes: workflows that go silent, and workflows that get too loud (too expensive). It gives you heartbeats, failure alerts, spend tracking, and kill switches, wired into a tiny HTTP API that any n8n, Make, or Zapier workflow can call with a plain webhook step.

## Why this exists

Most no-code automation platforms have decent per-run logging, but almost none of them give you cross-workflow visibility by default, and none of them give you a portfolio-wide view of "is anything broken right now" or "is anything about to blow through budget." As a solo builder or small agency, your actual job once a workflow ships isn't building, it's noticing. Noticing takes either a person checking dashboards all day, or a system that pages you.

There are commercial uptime and monitoring tools, but most of them are built to ping a URL and check for a 200 status. That's a different problem. Automation workflows don't fail by returning a bad HTTP code, they fail by silently not running, or running and quietly doing the wrong thing a thousand times. You need something that understands "this workflow is supposed to run roughly every hour" and "this workflow should never cost more than $20 a day," and that can forcibly stop a workflow mid-flight if either of those gets violated.

This is scaffolding for exactly that, built with real APIs (your own webhook calls, Slack's incoming webhook API) and nothing that depends on scraping a platform's internal dashboard, since those break the moment a vendor changes their UI.

## Who this is for

This is for solo automation builders and small agencies who are past the point of maintaining two or three workflows by memory. Once you're responsible for fifteen, thirty, or a hundred client workflows across n8n, Make, and Zapier, you need a system of record that isn't "I'll notice if the client complains." This toolkit assumes you're comfortable running a small Node service somewhere (a $5 VPS, a Render or Railway instance, a Raspberry Pi in a closet), and that you're willing to add one or two HTTP steps to your existing workflows.

This is not for teams who need enterprise SSO, multi-tenant billing, or a hosted SaaS dashboard out of the box. It's a foundation you adapt to your own stack, not a finished product you point at your client list and walk away from.

## What's in the box

```
automation-health-guardrails/
├── src/
│   └── server.js        # the whole service: heartbeats, spend, kill switch, checker cron
├── .env.example         # config template
├── .gitignore
├── LICENSE
└── README.md
```

It's deliberately one file. The logic here is simple enough that splitting it into a dozen modules would just make it harder to read and adapt. Once you start adding real features (a dashboard, per-client auth, multi-channel alerting), split it up then, on your own terms.

## Quick start

```bash
git clone https://github.com/elikem2021/automation-health-guardrails.git
cd automation-health-guardrails
npm install express better-sqlite3 node-cron dotenv
cp .env.example .env
# edit .env and drop in your Slack incoming webhook URL
node src/server.js
```

That starts an HTTP server on port 3000 (configurable) backed by a local SQLite file. No external database, no message queue, no Docker Compose stack required to get started. Once it's running, register a workflow:

```bash
curl -X PUT http://localhost:3000/workflows/client-acme-invoice-sync \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme invoice sync", "platform": "n8n", "expected_interval_minutes": 60, "spend_limit_usd": 15}'
```

That tells the service this workflow should check in roughly every hour, and should never spend more than $15 in a tracking period.

## How the heartbeat detection works

Every workflow run should call `POST /heartbeat/:id` as its first step. Each call just stamps `last_heartbeat_at` with the current time. Separately, a cron job inside the service runs every 5 minutes and compares that timestamp against the `expected_interval_minutes` you set when registering the workflow.

The check uses a 2x grace multiplier: a workflow expected every 60 minutes only triggers an alert after 120 minutes of silence. This isn't arbitrary. Real-world runs slip: a vendor API has a slow day, a queue backs up, a cron trigger fires a few minutes late. A 1x threshold produces constant false alarms and you'll start ignoring them, which defeats the entire point. A 2x grace period catches genuinely dead workflows (crashed, disabled, broken credential) while tolerating normal jitter.

When the grace period is exceeded, the service writes an entry to the `alerts_log` table and fires a Slack message if `SLACK_WEBHOOK_URL` is set. You get a message like:

```
[MISSED_HEARTBEAT] client-acme-invoice-sync: No heartbeat in 134 minutes (expected every 60).
```

## How spend tracking and the kill switch work together

After any step that burns paid API credits (an LLM call, an SMS send, a paid enrichment lookup), have the workflow call `POST /spend/:id` with the dollar amount that step cost:

```bash
curl -X POST http://localhost:3000/spend/client-acme-invoice-sync \
  -H "Content-Type: application/json" \
  -d '{"amount_usd": 0.42}'
```

The service keeps a running total in `spend_this_period_usd`. Once that total crosses the `spend_limit_usd` you set, two things happen automatically: an alert fires, and the workflow's `killed` flag flips to `1`. From that point on, `GET /kill-switch/:id` returns `{"killed": true}` until a human flips it back with `POST /kill-switch/:id`.

The missing piece, deliberately left for you to wire: periods don't reset themselves. This scaffold tracks cumulative spend since the workflow was registered, not spend-per-day or spend-per-month. For a real deployment you'll want a scheduled job that resets `spend_this_period_usd` to zero on whatever cadence matches your client's billing cycle, and probably a per-workflow `period_started_at` reset alongside it. That's a few lines of SQL and a cron entry, but it depends on how your clients bill, so it isn't baked in here.

## Wiring the kill switch into your workflows

The kill switch only works if your workflow actually checks it before doing anything expensive or risky. The pattern is the same across all three platforms: add an HTTP Request step near the top of the workflow, call `GET /kill-switch/:id`, and branch on the result.

**n8n**: add an HTTP Request node pointed at `GET http://your-server:3000/kill-switch/client-acme-invoice-sync`, then an IF node checking `{{$json.killed}} === true`, routing the true branch to a NoOp (or a Slack notification) and the false branch to the rest of your workflow.

**Make.com**: add an HTTP module (GET) as the first module after your trigger, then a Router with a filter on `killed = false` for the branch that continues, and a filter on `killed = true` for a branch that just stops (or sends you a notification confirming the pause is active).

**Zapier**: add a "Webhooks by Zapier" GET step first, then a Filter step with the condition `killed` (Boolean) "is false" to let the rest of the Zap continue.

Any of these takes two to five minutes to add to an existing workflow. The cost of adding it once is a lot lower than the cost of a client watching a $600 OpenAI bill roll in because a loop never found its exit condition.

## Why we built this

We build and maintain client automations at Avalux, and the two 2am messages we got tired of were "did it actually run last night" and "why is this month's API bill four times normal." Both are preventable with cheap, boring infrastructure: a timestamp check and a running total. Neither needs a vendor platform or a subscription; they need a webhook call you were probably one step away from adding anyway.

We're releasing this as a starting point, not a finished monitoring product. If you're running this for real client work, you'll want to add authentication on the API endpoints, a dashboard instead of raw curl calls, and a period-reset job that matches your billing cycle. The core logic (heartbeat comparison, cumulative spend against a limit, a boolean kill flag your workflows respect) is the part worth keeping stable. Everything around it is yours to shape.

If you want this hardened, integrated into your existing client stack, or extended with a dashboard and multi-channel alerting, that's the kind of work we do. Reach out through [avalux.io](https://avalux.io).

## Avalux's other open source projects

- [freight-eta-toolkit](https://github.com/elikem2021/freight-eta-toolkit), geofencing and ETA calculation scaffolding for freight and logistics operators.
- [avalux-open-source](https://github.com/elikem2021/avalux-open-source), the index of all of Avalux's public repos.

## License

MIT. See [LICENSE](./LICENSE).

## Keywords

automation monitoring, workflow failure alerts, control automation costs, n8n monitoring, Make.com monitoring, Zapier monitoring, automation uptime, workflow heartbeat, automation kill switch, API spend tracking, no-code automation reliability, client automation maintenance, agency automation ops