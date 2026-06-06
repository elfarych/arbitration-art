/** Точка входа сервиса-коннектора. */

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
  console.error('Фатальная ошибка запуска:', error);
  process.exit(1);
});
