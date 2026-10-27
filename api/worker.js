import { waitUntil } from '@vercel/functions';
import { kickWorker, workerAuthorized } from '../src/control.js';
import { logger } from '../src/logger.js';
import { runSession } from '../src/worker.js';

// Must match "api/worker.js".maxDuration in vercel.json.
const MAX_DURATION_S = 800;
// Kept after the session deadline for finishing turns, saving keys and starting the next session.
const RESERVE_MS = 75_000;

/**
 * Started by the cron every minute and by the previous session when it ends. If no session holds
 * the WhatsApp connection, this one takes it for ~12 minutes and then hands over.
 */
export default function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET is not set' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (process.env.VERCEL_ENV !== 'production') return res.json({ skipped: 'the worker only runs in production' });

  const deadline = Date.now() + MAX_DURATION_S * 1000 - RESERVE_MS;
  waitUntil(
    runSession({ deadline })
      .then(async (result) => {
        logger.info({ result }, 'worker session ended');
        if (result === 'done') await kickWorker();
      })
      .catch((err) => logger.error({ err }, 'worker session crashed')),
  );
  res.status(202).json({ started: true });
}
