/** Точка входа API-сервиса. */

import { buildApp } from './app';
import { loadConfig } from './config/env';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'остановка API…');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error({ err: error }, 'ошибка при остановке');
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error('Фатальная ошибка запуска:', error);
  process.exit(1);
});
