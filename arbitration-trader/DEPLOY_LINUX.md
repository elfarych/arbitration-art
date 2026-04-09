# 🚀 Руководство по деплою Arbitration Trader на Linux (Ubuntu / Fedora)

При развертывании высокочастотного арбитражного бота на арендованном Linux-сервере (VPS) критически важно обеспечить три вещи: **Абсолютно точное системное время**, **надежный менеджер процессов (PM2)** и **правильное окружение**.

Ниже представлена пошаговая инструкция от запуска "голого" сервера до работающего бота.

---

## Шаг 1. Первичная настройка и синхронизация времени (КРИТИЧНО)

Если часы сервера разойдутся с API-шлюзами Binance/Bybit хотя бы на 500 миллисекунд — ваши ордера будут отклоняться с ошибкой `Timestamp for this request is outside of the recvWindow`.

### Настройка времени для ОС Ubuntu / Debian:
```bash
# 1. Запустить обновление пакетов
sudo apt update && sudo apt upgrade -y

# 2. Включить аппаратную встроенную синхронизацию (systemd)
sudo timedatectl set-ntp true

# 3. (Опционально, но рекомендуется) Установить Chrony для сверхточной синхронизации
sudo apt install chrony -y
sudo systemctl enable --now chrony
```

### Настройка времени для ОС Fedora / CentOS / RHEL:
```bash
# 1. Запустить обновление
sudo dnf update -y

# 2. Установить и запустить Chrony
sudo dnf install chrony -y
sudo systemctl enable --now chronyd
```

### Проверка часов (Для любой ОС):
Выполните команду отслеживания. Значение `System time` отклонения должно быть в пределах `0.000...` секунд.
```bash
chronyc tracking
```

---

## Шаг 2. Установка Node.js и pnpm

Бот написан на TypeScript под современный стек. Рекомендуется использовать Node.js версии 20.x (LTS).

```bash
# 1. Установите cURL (если нет)
sudo apt install curl -y # Ubuntu
# sudo dnf install curl -y # Fedora

# 2. Установите Node.js 20.x через NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs # Ubuntu
# sudo dnf install -y nodejs # Fedora

# 3. Установка пакетного менеджера pnpm и TypeScript глобально
sudo npm install -g pnpm typescript tsx
```

---

## Шаг 3. Деплой проекта и установка зависимостей

Перенесите файлы проекта на ваш сервер (через `git clone`, `scp` или FTP) в папку, например, `/var/www/arbitration-trader`.

```bash
# 1. Перейдите в папку проекта
cd /var/www/arbitration-trader

# 2. Установите все зависимости без генерации package-lock.json
pnpm install
```

---

## Шаг 4. Конфигурация (.env)

На боевом сервере вам потребуются **боевые (Mainnet)** API-ключи, и нужно отключить режим песочницы.

```bash
# Создайте копию конфига
cp .env.example .env

# Откройте конфиг в редакторе nano
nano .env
```

Внутри файла обязательно убедитесь в правильности ключей:
```env
# CRITICAL: Отключение песочницы для реальной торговли
USE_TESTNET=false

# Вставьте ваши реальные ключи от счетов Futures/Derivatives
BINANCE_API_KEY=ваш_реальный_ключ
BINANCE_SECRET_KEY=ваш_реальный_секрет

BYBIT_API_KEY=ваш_реальный_ключ
BYBIT_SECRET_KEY=ваш_реальный_секрет

# Укажите IP-адрес вашего Django-бэкенда (если он на другом сервере)
DJANGO_API_URL=http://ваш-айпи:8000/api
```
*(Для сохранения в nano: нажмите `Ctrl+O`, затем `Enter`, затем `Ctrl+X`)*

---

## Шаг 5. Запуск через PM2 (Продакшн)

Вы не можете просто написать `tsx src/main.ts` — если вы закроете терминал (SSH-клиент), бот умрет. Нам нужен демонизатор процессов `PM2`.

```bash
# 1. Установите PM2 глобально
sudo npm install -g pm2

# 2. Скомпилируйте TypeScript проект в чистый JavaScript (папка dist/)
pnpm run build

# 3. Запустите бота через PM2
pm2 start dist/main.js --name "arbitration-trader"

# 4. Добавьте PM2 в автозагрузку (чтобы бот поднимался сам при ребуте VPS)
pm2 startup
# (PM2 выдаст длинную команду в терминале, скопируйте её и выполните)
pm2 save
```

---

## 🛠 Полезные команды для администрирования

- `pm2 logs arbitration-trader` — смотреть логи торговли в реальном времени.
- `pm2 stop arbitration-trader` — временно остановить бота.
- `pm2 restart arbitration-trader` — перезагрузить бота (например, если изменили файл `.env`).
- `pm2 monit` — классная консольная утилита мониторинга ОЗУ и CPU процесса.

> [!IMPORTANT] 
> Если вы вносите правки в код на локальном компьютере, не забудьте после переноса файлов на Linux-сервер обязательно писать `pnpm run build` перед тем как делать `pm2 restart arbitration-trader`. PM2 в продакшене запускает именно скомпилированный JS-билд из папки `/dist`, а не сырой TypeScript!
