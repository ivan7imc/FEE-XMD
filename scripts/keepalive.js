#!/usr/bin/env node
/**
 * Pings the bot's /health endpoint so a Render **free** instance does not spin
 * down after 15 minutes of inactivity (a sleeping instance = offline bot).
 *
 * Usage:
 *   APP_URL=https://fee-xmd.onrender.com node scripts/keepalive.js
 *
 * Run it from:
 *   - a Render Cron Job (paid plans) — see the commented block in render.yaml
 *   - a free external monitor (UptimeRobot, cron-job.org, ...) hitting
 *     https://<your-service>.onrender.com/health every 5-10 minutes
 */
const url = (process.env.APP_URL || 'http://127.0.0.1:' + (process.env.PORT || 10000)).replace(/\/+$/, '');

try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const uptime = Number(JSON.parse(body).uptime || 0);
    console.log(`[keepalive] ${url}/health -> ${res.status} (uptime ${Math.round(uptime)}s)`);
} catch (err) {
    console.error(`[keepalive] ${url}/health failed: ${err.message}`);
    process.exit(1);
}
