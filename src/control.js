import crypto from 'node:crypto';
import { redis } from './redis.js';

/*
 * Coordination between the dashboard functions and the single worker session that holds the
 * WhatsApp connection. Everything goes through Redis because they run in separate invocations.
 */

const LEASE_KEY = 'worker:lock';
const STATE_KEY = 'wa:state';
const CMD_KEY = 'wa:cmd';
const DASH_KEY = 'dash:active';
const CMD_MAX_AGE_MS = 2 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => {
  try {
    return s == null ? null : JSON.parse(s);
  } catch {
    return null;
  }
};

/* ---------- connection state (worker writes, dashboard reads) ---------- */

export async function publishState(state) {
  await redis().set(STATE_KEY, JSON.stringify({ ...state, updatedAt: Date.now() }));
}

export async function readControl() {
  const [state, lease] = await redis().mget(STATE_KEY, LEASE_KEY);
  return { state: parse(state), running: !!lease };
}

/* ---------- dashboard presence: an unlinked worker only shows QR codes while someone looks ---------- */

let lastMark = 0;
export async function markDashboardActive() {
  if (Date.now() - lastMark < 30_000) return;
  lastMark = Date.now();
  await redis().set(DASH_KEY, '1', { ex: 180 });
}

export async function dashboardActive() {
  return (await redis().exists(DASH_KEY)) > 0;
}

/* ---------- commands (dashboard asks, worker answers) ---------- */

export async function sendCommand(type, payload = {}, waitMs = 20_000) {
  const id = crypto.randomUUID();
  await redis().rpush(CMD_KEY, JSON.stringify({ id, type, ...payload, at: Date.now() }));
  for (const until = Date.now() + waitMs; Date.now() < until; ) {
    await sleep(1000);
    const answer = await redis().get(`${CMD_KEY}:${id}`);
    if (answer) return parse(answer);
  }
  return null;
}

export async function nextCommand() {
  for (;;) {
    const cmd = parse(await redis().lpop(CMD_KEY));
    if (!cmd) return null;
    if (Date.now() - cmd.at < CMD_MAX_AGE_MS) return cmd; // drop requests nobody waits for anymore
  }
}

export async function answerCommand(cmd, answer) {
  await redis().set(`${CMD_KEY}:${cmd.id}`, JSON.stringify(answer), { ex: 120 });
}

/* ---------- the lease: at most one session holds the WhatsApp connection ---------- */

export async function acquireLease(ttlMs) {
  const token = crypto.randomUUID();
  return (await redis().set(LEASE_KEY, token, { nx: true, px: ttlMs })) ? token : null;
}

export async function renewLease(token, ttlMs) {
  if ((await redis().get(LEASE_KEY)) !== token) return false;
  await redis().set(LEASE_KEY, token, { xx: true, px: ttlMs });
  return true;
}

export async function releaseLease(token) {
  if ((await redis().get(LEASE_KEY)) === token) await redis().del(LEASE_KEY);
}

/* ---------- starting worker sessions on Vercel ---------- */

export function workerAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

/** Starts a worker session now instead of waiting for the next cron tick. */
export async function kickWorker(host = process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  if (!host || !process.env.CRON_SECRET) return false;
  const res = await fetch(`https://${host}/api/worker`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}
