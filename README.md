# EcoFlow → Telegram

Cloudflare Worker, який раз на хвилину опитує станції EcoFlow і пише в Telegram.
Маринка (DELTA 3 Max Plus) — через офіційний IoT Open API; UPS Kate / UPS Router (River 3) — через MQTT застосунку EcoFlow (`src/mqtt.ts`, `src/protobuf.ts`).

- 🔋 / 🪫 / 🚨 при розряді до **50 / 25 / 10 %** — з орієнтовним часом роботи (hh:mm) і споживанням;
- 💡 «Світло пішло / повернулось» (по входу AC) з тривалістю відключення;
- ⚠️ якщо станція не на зв'язку довше 30 хв;
- команди в групі: `/status`, `/marinka`, `/kate`, `/router`, `/help`.

Світло визначається по вхідній потужності UPS Router (`GRID_SOURCE`).

Тихий режим 00:00–08:00 (Київ, `QUIET_FROM`/`QUIET_TO`): усе приходить без звуку, крім 🚨 10%.

Поріг «зводиться» знову, коли заряд піднімається на 10 % вище за нього. Стан — у KV `POWER_KV`.

## Налаштування

Пристрої та пороги — константи на початку `src/index.ts`.

GitHub → Settings → Secrets and variables → Actions:

| Secret | Звідки |
|---|---|
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → шаблон «Edit Cloudflare Workers» |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages (праворуч) |
| `ECOFLOW_ACCESS_KEY`, `ECOFLOW_SECRET_KEY` | developer-eu.ecoflow.com → Security |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `TELEGRAM_CHAT_ID` | `https://api.telegram.org/bot<TOKEN>/getUpdates` |
| `EF_EMAIL`, `EF_PASSWORD` | логін і пароль від застосунку EcoFlow (для MQTT) |
| `TG_WEBHOOK_SECRET` | будь-який випадковий рядок: `openssl rand -hex 32` |

Деплой — автоматично при push у `main` (або Actions → Deploy worker → Run workflow).

Логи: `npx wrangler tail` або Cloudflare dashboard → Workers → frosty-union-469b → Logs.

## Обмеження

Офіційний API для River 2 / River 3 повертає `1006 current device is not allowed`, тому UPS читаються через неофіційний MQTT застосунку. Після оновлень прошивки/застосунку EcoFlow формат може змінитись — тоді `tools/probe` допоможе зняти новий дамп.
