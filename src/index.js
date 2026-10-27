import { config } from './config.js';
import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { WhatsApp } from './whatsapp.js';
import { createRouter } from './router.js';
import { startServer } from './server.js';

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.dashboardPassword) {
  logger.warn('HOST is not local and DASHBOARD_PASSWORD is empty - anyone on the network can control the agent');
}

const wa = new WhatsApp({ selfName: () => getSettings().agentName });
const router = createRouter(wa);
startServer({ wa, router });
await wa.start();

const shutdown = async () => {
  await wa.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
