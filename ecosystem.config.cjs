// PM2 orchestration for the arbitration-art backend — LOCAL DEV (hot-reload).
//
// Runs the Django REST API, the bot engine, and the art-level-screener services
// (connector -> [processor] -> api). The Quasar frontend is intentionally NOT
// managed here — run it separately via `quasar dev`.
//
// DEV mode: sources are run directly with hot-reload, NO build step needed —
//   - Node/TS services: `tsx watch src/<entry>.ts` (PM2 tracks tsx; tsx restarts
//     the app on file change). Requires deps installed so `node_modules/.bin/tsx`
//     exists (`pnpm install` / `npm install` in each service).
//   - Django: `runserver` WITHOUT `--noreload`, i.e. Django's autoreloader on.
//
// This config is local-only. For production run the COMPILED output instead
// (each service's `npm run build` then `npm start` / `node dist/...`).
//
// Caveat (Django autoreload under PM2): the autoreloader forks a child PM2 does
// not track; on `pm2 restart/stop django` the child may briefly orphan and hold
// :8000. If a restart "hangs" on the port, kill the stray python and retry.
//
// Prerequisites (NOT managed by PM2 — infra/external):
//   - Redis (levels services):            e.g. `redis-server`, or a Docker container
//   - PostgreSQL (Django):                cd arbitration-art-django && make db-up
//   - Django migrations applied:          cd arbitration-art-django && make migrate
//   - Deps installed (for tsx):           per service `pnpm install` / `npm install`
//
// Usage:
//   pm2 start ecosystem.config.cjs        # start everything (dev)
//   pm2 status                            # list processes
//   pm2 logs levels-api                   # tail one app
//   pm2 restart all  |  pm2 delete all    # restart / tear down
//
// Ports: django 8000 · bot-engine 3001 · levels-api 3000 (connector/processor are workers).

const path = require('path');

const root = __dirname;
const djangoDir = path.join(root, 'arbitration-art-django');
const engineDir = path.join(root, 'arbitration-bot-engine');
const servicesDir = path.join(root, 'art-level-screener', 'services');

// A Node/TS service in dev: run `tsx watch <entry>` directly. `interpreter:'none'`
// makes PM2 exec the tsx bin (its node shebang runs it); tsx owns hot-reload.
// `cwd` must be the service dir so each loads its own `.env` (dotenv) and resolves
// its local `node_modules/.bin/tsx`.
const nodeDev = (name, cwd, entry) => ({
  name,
  cwd,
  script: 'node_modules/.bin/tsx',
  args: `watch ${entry}`,
  interpreter: 'none',
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  // Services install SIGINT/SIGTERM graceful-shutdown handlers — give them room.
  kill_timeout: 6000,
  env: { NODE_ENV: 'development' },
});

module.exports = {
  apps: [
    // --- Django REST API (port 8000) — autoreload on --------------------
    {
      name: 'django',
      cwd: djangoDir,
      script: 'manage.py',
      interpreter: path.join(djangoDir, 'venv', 'bin', 'python'),
      // No --noreload: Django's StatReloader restarts on .py changes. See the
      // autoreload caveat in the header.
      args: 'runserver 127.0.0.1:8000',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: { PYTHONUNBUFFERED: '1' },
    },

    // --- Bot engine (Fastify, port 3001) ---------------------------------
    nodeDev('bot-engine', engineDir, 'src/main.ts'),

    // --- art-level-screener pipeline: connector -> [processor] -> api -----
    // Decoupled through Redis; start order is not strict (each one retries),
    // but listing in data-flow order keeps `pm2 status` readable.
    nodeDev('levels-connector', path.join(servicesDir, 'binance-futures-connector'), 'src/index.ts'),
    // nodeDev('levels-processor', path.join(servicesDir, 'levels-processor'), 'src/index.ts'),
    nodeDev('levels-api', path.join(servicesDir, 'levels-api'), 'src/index.ts'),
  ],
};
