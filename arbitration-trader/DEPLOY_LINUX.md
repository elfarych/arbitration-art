# Руководство по деплою Arbitration Trader на Linux

`arbitration-trader` - standalone Node.js/TypeScript сервис реальной торговли. Он не хранит биржевые ключи в `.env`: ключи и торговые параметры приходят из Django runtime payload. Локальный `.env` содержит инфраструктурные переменные процесса, safety guards, пути lock/journal и production caps.

## 1. Системное время

Для signed exchange REST API требуется точное время сервера. На Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y chrony
sudo systemctl enable --now chrony
chronyc tracking
```

Отклонение должно быть минимальным. Ошибки времени приводят к отказам signed requests и могут оставить runtime без возможности быстро закрыть позицию.

## 2. Node.js и зависимости

Используйте Node.js версии, совместимой с текущим проектом, и `pnpm`.

```bash
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

Установка проекта:

```bash
cd /var/www/arbitration-trader
pnpm install
pnpm run build
pnpm test
```

## 3. `.env`

Создайте `.env` из `.env.example`:

```bash
cp .env.example .env
nano .env
```

Минимальный набор:

```env
DJANGO_API_URL=http://127.0.0.1:8000/api
SERVICE_SHARED_TOKEN=replace-with-strong-shared-token
PORT=3002
SHADOW_SIGNAL_LOG_PATH=logs/shadow-signals.jsonl
EXECUTION_JOURNAL_PATH=logs/execution-journal.jsonl
TRADER_PROCESS_LOCK_PATH=locks/trader-runtime.lock
PUBLIC_HEALTH_DETAILS=false
FAIL_ON_UNRESOLVED_EXECUTION_JOURNAL=true
POSITION_SIZE_TOLERANCE_PERCENT=0.1
ALLOW_PRODUCTION_TRADING=false
TRADER_ENVIRONMENT=development
PRODUCTION_TRADING_ENVIRONMENT=production
PRODUCTION_ACCOUNT_FINGERPRINTS=
MAX_PRODUCTION_TRADE_AMOUNT_USDT=
MAX_PRODUCTION_CONCURRENT_TRADES=
MAX_PRODUCTION_LEVERAGE=
```

В `.env` не должны находиться `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BYBIT_API_KEY`, `BYBIT_SECRET_KEY`, `GATE_*` или `MEXC_*`. Эти значения приходят из Django payload для конкретного `TraderRuntimeConfig`.

`ALLOW_PRODUCTION_TRADING=false` блокирует runtime payload с `use_testnet=false`. Для production процесса live payload принимается только когда дополнительно настроены `TRADER_ENVIRONMENT=production`, allowlist `PRODUCTION_ACCOUNT_FINGERPRINTS` для выбранной пары API keys и hard caps `MAX_PRODUCTION_TRADE_AMOUNT_USDT`, `MAX_PRODUCTION_CONCURRENT_TRADES`, `MAX_PRODUCTION_LEVERAGE`. Переключать live guards можно только после отдельной операционной подготовки: выделенный аккаунт, ограниченный баланс, private network/firewall, проверенный `SERVICE_SHARED_TOKEN`, monitoring/alerts и runbook для stuck positions.

## 4. Запуск через PM2

```bash
sudo npm install -g pm2
cd /var/www/arbitration-trader
pnpm run build
pm2 start dist/main.js --name arbitration-trader --time
pm2 save
pm2 startup
```

Команды:

```bash
pm2 logs arbitration-trader
pm2 monit
pm2 restart arbitration-trader
```

Не запускайте несколько PM2 instances на один и тот же exchange account. `TRADER_PROCESS_LOCK_PATH` защищает только один host/deployment directory; для нескольких серверов нужен внешний DB/Redis lock.

## 5. Health и stop behavior

`GET /health` без `X-Service-Token` возвращает только public-safe `{ success: true, status: "ok" }`, если `PUBLIC_HEALTH_DETAILS=false`. Детальный `GET /health` с `X-Service-Token` возвращает:

- `active_runtime_config_id`;
- `runtime_state`: `idle`, `running`, `risk_locked`, `stopping_with_open_exposure`;
- `risk_locked`;
- `risk_incidents`;
- `open_exposure`.

`POST /engine/trader/stop` не считается успешным, если позиции, pending close sync или unmanaged exposure не подтверждены как закрытые/синхронизированные. В таком случае runtime остается активным, блокирует новые входы и продолжает retry cleanup/close sync. PM2 или внешний supervisor не должен принудительно убивать процесс до flat/reconciled состояния.

## 6. Production checklist

Перед реальными деньгами:

1. Проверить `pnpm run build` и `pnpm test`.
2. Проверить детальный `/health` с `X-Service-Token` и service-token auth из Django.
3. Запустить testnet/shadow mode.
4. Проверить exchange health для выбранного runtime config.
5. Проверить, что `EXECUTION_JOURNAL_PATH` и `TRADER_PROCESS_LOCK_PATH` находятся на persistent disk и доступны пользователю PM2.
6. Настроить production account fingerprint allowlist и hard caps.
7. Сделать private smoke с минимальным размером и заранее ограниченным балансом.
8. Настроить firewall/private network/reverse proxy так, чтобы control plane не был публичным.
9. Настроить alerts на `risk_locked=true`, `runtime_state=stopping_with_open_exposure`, pending close sync и частые stale orderbooks.

Оставшиеся production blockers описаны в `DOCS.md`: database-backed execution ledger/state machine, external distributed account lock, полноценный metrics endpoint и max daily/session loss controls.
