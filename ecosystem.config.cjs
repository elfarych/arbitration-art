// PM2 orchestration for the arbitration-art backend.
//
// Runs the Django REST API, the bot engine, and the three art-level-screener
// services (connector -> processor -> api). The Quasar frontend is intentionally
// NOT managed here — it is served separately via `quasar dev` / nginx.
//
// Apps run the COMPILED output (matches each service's `npm start`), so build
// before the first start and after code changes.
//
// Prerequisites (NOT managed by PM2 — infra/external):
//   - Redis (levels services):            e.g. `redis-server`, or a Docker container
//   - PostgreSQL (Django):                cd arbitration-art-django && make db-up
//   - Django migrations applied:          cd arbitration-art-django && make migrate
//
// One-time build / install:
//   - bot engine:                 cd arbitration-bot-engine && pnpm install && pnpm build
//   - each levels service:        cd art-level-screener/services/<svc> && npm install && npm run build
//   - Django deps in venv:        cd arbitration-art-django && make install
//
// Usage:
//   pm2 start ecosystem.config.cjs        # start everything
//   pm2 status                            # list processes
//   pm2 logs                              # tail all logs
//   pm2 logs levels-api                   # tail one app
//   pm2 restart all  |  pm2 delete all    # restart / tear down
//
// Ports: django 8000 · bot-engine 3001 · levels-api 3000 (connector/processor are workers).

const path = require('path');

const root = __dirname;
const djangoDir = path.join(root, 'arbitration-art-django');
const engineDir = path.join(root, 'arbitration-bot-engine');
const servicesDir = path.join(root, 'art-level-screener', 'services');

// Shared defaults for the Node (TypeScript) services. Each service loads its own
// `.env` from its cwd via dotenv, so cwd must point at the service directory.
const nodeService = {
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  // Services install SIGINT/SIGTERM graceful-shutdown handlers — give them room.
  kill_timeout: 6000,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    // --- Django REST API (port 8000) -------------------------------------
    {
      name: 'django',
      cwd: djangoDir,
      script: 'manage.py',
      interpreter: path.join(djangoDir, 'venv', 'bin', 'python'),
      // --noreload: PM2 owns the process lifecycle (Django's autoreloader forks
      // a child PM2 can't track). 127.0.0.1:8000 matches the engine's
      // DJANGO_API_URL and the frontend's API_URL.
      args: 'runserver 127.0.0.1:8000 --noreload',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: { PYTHONUNBUFFERED: '1' },
    },

    // --- Bot engine (Fastify, port 3001) ---------------------------------
    {
      ...nodeService,
      name: 'bot-engine',
      cwd: engineDir,
      script: 'dist/main.js',
    },

    // --- art-level-screener pipeline: connector -> processor -> api -------
    // Decoupled through Redis; start order is not strict (each one retries),
    // but listing in data-flow order keeps `pm2 status` readable.
    {
      ...nodeService,
      name: 'levels-connector',
      cwd: path.join(servicesDir, 'binance-futures-connector'),
      script: 'dist/index.js',
    },
    // {
    //   ...nodeService,
    //   name: 'levels-processor',
    //   cwd: path.join(servicesDir, 'levels-processor'),
    //   script: 'dist/index.js',
    // },
    {
      ...nodeService,
      name: 'levels-api',
      cwd: path.join(servicesDir, 'levels-api'),
      script: 'dist/index.js',
    },
  ],
};
