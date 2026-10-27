import { isLinked } from './auth-state.js';
import * as control from './control.js';
import { logger } from './logger.js';
import { createRouter } from './router.js';
import { getSettings } from './settings.js';
import { WhatsApp } from './whatsapp.js';

const log = logger.child({ module: 'worker' });

const LEASE_TTL_MS = 120_000; // a crashed session blocks the next one for at most this long
const RENEW_MS = 45_000;
const DRAIN_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Holds the WhatsApp connection until `deadline`, then shuts down cleanly so the next session can
 * take over. A Redis lease makes sure only one session is connected at a time.
 *
 * Returns why it ended: 'busy' (another session holds the lease), 'idle' (nothing linked and no one
 * on the dashboard to scan a QR), 'done' (reached the deadline), 'logout', 'replaced', 'lost-lease'.
 */
export async function runSession({ deadline, waitForDashboard = true, createWhatsApp = (o) => new WhatsApp(o) }) {
  const token = await control.acquireLease(LEASE_TTL_MS);
  if (!token) return 'busy';
  let result = 'done';
  let wa;
  try {
    if (waitForDashboard && !(await isLinked()) && !(await control.dashboardActive())) return (result = 'idle');

    let agentName = (await getSettings()).agentName;
    wa = createWhatsApp({ selfName: () => agentName });
    wa.on('state', (s) => control.publishState(s).catch((err) => log.warn({ err }, 'state publish failed')));
    const router = createRouter(wa);
    await wa.start();
    await router.resumePending();

    let lastRenew = Date.now();
    let lastPoll = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (wa.fatal) {
        result = wa.fatal;
        break;
      }
      const open = wa.state.status === 'open';
      if (Date.now() - lastPoll >= (open ? 30_000 : 3_000)) {
        lastPoll = Date.now();
        const ended = await handleCommands(wa);
        if (ended) {
          result = ended;
          break;
        }
      }
      if (Date.now() - lastRenew >= RENEW_MS) {
        lastRenew = Date.now();
        if (!(await control.renewLease(token, LEASE_TTL_MS))) {
          result = 'lost-lease';
          break;
        }
        agentName = (await getSettings()).agentName;
        if (waitForDashboard && !wa.linked && !(await control.dashboardActive())) {
          result = 'idle';
          break;
        }
      }
    }
    if (result === 'done') await router.drain(DRAIN_MS);
  } finally {
    await wa?.stop().catch((err) => log.warn({ err }, 'stop failed'));
    if (result !== 'lost-lease') await control.releaseLease(token);
  }
  return result;
}

async function handleCommands(wa) {
  for (let cmd; (cmd = await control.nextCommand()); ) {
    if (cmd.type === 'logout') {
      await wa.logout();
      await control.answerCommand(cmd, { ok: true });
      return 'logout';
    }
    let answer;
    try {
      if (cmd.type === 'pair') answer = { code: await wa.requestPairingCode(cmd.phone) };
      else if (cmd.type === 'refreshGroups') answer = { groups: (await wa.refreshGroups()).length };
      else answer = { error: `unknown command: ${cmd.type}` };
    } catch (err) {
      answer = { error: err.message };
    }
    await control.answerCommand(cmd, answer);
  }
  return null;
}
