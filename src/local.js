// Local development: the same dashboard API plus static files, and one long-running worker session.
import express from 'express';
import { config } from './config.js';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { runSession } from './worker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = createApp();
app.use(express.static(config.publicDir));
app.listen(config.port, config.host, () => logger.info(`dashboard: http://localhost:${config.port}`));

// No time limit here. If the deployed worker shares this Redis and holds the lease, keep waiting.
for (;;) {
  const result = await runSession({ deadline: Date.now() + 6 * 3600_000, waitForDashboard: false }).catch((err) => {
    logger.error({ err }, 'worker session crashed');
    return 'crashed';
  });
  logger.info({ result }, 'worker session ended');
  await sleep(result === 'done' ? 0 : 15_000);
}
