# EcoFlow → Telegram

Cloudflare Worker, який раз на хвилину опитує EcoFlow IoT Open API (EU) і пише в Telegram:

- 🔋 / 🪫 / 🚨 при розряді до **50 / 25 / 10 %** — з орієнтовним часом роботи (hh:mm) і споживанням;
- 💡 «Світло пішло / повернулось» (по входу AC) з тривалістю відключення;
- ⚠️ якщо станція не на зв'язку довше 30 хв.

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

Деплой — автоматично при push у `main` (або Actions → Deploy worker → Run workflow).

Логи: `npx wrangler tail` або Cloudflare dashboard → Workers → frosty-union-469b → Logs.

## Обмеження

API віддає дані лише для DELTA 3 Max Plus. RIVER 2 / River 3 (UPS) повертають `1006 current device is not allowed` — для них потрібен MQTT через логін застосунку (окремий сервіс).
