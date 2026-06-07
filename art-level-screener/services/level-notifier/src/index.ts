/** Entry point of the level-notification service. */

import { Application } from './core/application';
import { loadConfig } from './config/env';
import { createLogger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const application = new Application(config, logger);
  await application.start();
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
