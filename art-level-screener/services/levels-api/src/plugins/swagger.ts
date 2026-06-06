/** Плагин: OpenAPI-спека (@fastify/swagger) и Swagger UI на /docs. */

import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Levels Screener API',
          version: '0.1.0',
          description:
            'API горизонтальных уровней Binance Futures для скринера. ' +
            'Данные обновляются раз в ~10с; используйте поллинг.',
        },
        tags: [
          { name: 'screener', description: 'Экран скринера и детали по монете' },
          { name: 'meta', description: 'Метаданные и health' },
        ],
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  },
  { name: 'swagger' },
);
