import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env file - rely on the real environment
}

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  authDir: path.join(root, 'data', 'auth'),
  dbPath: path.join(root, 'data', 'agent.db'),
  publicDir: path.join(root, 'public'),
  port: Number(process.env.PORT || 3300),
  host: process.env.HOST || '127.0.0.1',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};
