# EcoFlow → Telegram

Telegram-бот, який стежить за зарядкою ваших станцій EcoFlow і пише в групу:

- 🔋 / 🪫 / 🚨 при розряді до **50 / 25 / 10 %** — з прогнозом часу роботи (hh:mm) і споживанням;
- 🕯 «Світло пішло» / 💡 «Світло повернулось» — з тривалістю відключення і станом усіх станцій;
- ⚠️ якщо станція не на зв'язку довше 30 хв;
- кнопки під кожним повідомленням і команди `/status`, `/<станція>`, `/help`;
- тихий режим 00:00–08:00: усе без звуку, крім найнижчого порогу.

```
📊 Стан станцій  14:40:12
┃ 🔋 Маринка
┃ ▰▰▰▰▰▰▰▰▰▱  99%
┃ 🔌 від мережі · ⚡ 45 Вт

┃ 🪫 UPS Router
┃ ▰▰▱▱▱▱▱▱▱▱  23%
┃ ⏳ 01:05 · ⚡ 8 Вт
🕯 Світла немає 2 год 10 хв · з 12:30
[ 📊 Усі станції ]
[ Маринка ][ UPS Kate ][ UPS Router ]
```

Кожне натискання кнопки надсилає нове повідомлення, а з попереднього кнопки прибираються — історія лишається, кнопки завжди лише під останнім.

Працює як **Cloudflare Worker** (безкоштовний тариф, перевірка щохвилини), деплой — **GitHub Actions** при push у `main`. Ні сервера, ні ввімкненого комп'ютера не потрібно.

---

## Як це влаштовано

| Тип станції | Звідки дані |
|---|---|
| Моделі, які віддає офіційний **EcoFlow IoT Open API** (перевірено: DELTA 3 Max Plus) | REST з підписом HMAC — `via: 'rest'` |
| Моделі, на які API відповідає `1006 current device is not allowed` (перевірено: River 3 / серійники `R65…`) | MQTT застосунку EcoFlow (логін email+пароль), protobuf — `via: 'mqtt'` |

Щохвилини воркер бере список пристроїв (онлайн/офлайн), читає REST-станції, підключається до MQTT, чекає до 15 с на пакет батареї від кожної MQTT-станції, порівнює з порогами і за потреби пише в Telegram. Стан (які пороги вже сповіщені, світло) — у Cloudflare KV, запис лише при змінах.

> ⚠️ **Сумісність.** Перевірено тільки на DELTA 3 Max Plus (REST) і River 3 (MQTT). Інші моделі можуть мати інші назви полів у REST або інший формат protobuf — тоді заряд буде «немає даних». Для діагностики є `tools/` (див. нижче).

---

## Що знадобиться

- акаунт **GitHub** (репозиторій краще приватний);
- акаунт **Cloudflare** (безкоштовний, карта не потрібна);
- **Telegram**;
- акаунт у застосунку **EcoFlow** з email і паролем (не вхід через Google/Apple — якщо так, задайте пароль у налаштуваннях акаунта);
- **Node.js 20+** на комп'ютері для одноразового налаштування.

---

## Налаштування крок за кроком

### 1. Скопіюйте репозиторій

**Use this template** / **Fork** на GitHub (або створіть новий приватний репозиторій і залийте туди код), потім:

```bash
git clone git@github.com:<ви>/<repo>.git && cd <repo>
npm install
```

### 2. Ключі EcoFlow Developer

1. Зайдіть на **developer-eu.ecoflow.com** (Європа) або **developer.ecoflow.com** (US) тим самим акаунтом, що й у застосунку.
2. **Become a Developer** → дочекайтесь листа про схвалення (буває від кількох хвилин до кількох днів).
3. Розділ **Security** → створіть **Access Key** і **Secret Key**. Secret показується один раз — збережіть.

> Акаунт у регіоні US? Змініть `API` у `src/config.ts` на `https://api.ecoflow.com`.

### 3. Перевірте свої станції

```bash
ACCESS_KEY='...' SECRET_KEY='...' node tools/check-api.mjs
```

Для кожної станції скрипт виведе готовий рядок для конфігу, напр.:

```
→ Маринка: { sn: 'D3M1ZE1A9H990005', via: 'rest' }
→ UPS Kate: { sn: 'R655ZEBAXH170579', via: 'mqtt' }
```

- `code 0` → `via: 'rest'`
- `code 1006` → `via: 'mqtt'`
- `8521 signature is wrong` → переплутані або неповні ключі.

### 4. Telegram-бот і група

1. **@BotFather** → `/newbot` → ім'я → username на `bot` → отримаєте **токен**.
2. Створіть **приватну** групу, додайте туди бота (і людей, кому треба сповіщення).
3. Напишіть у групі `/start@ваш_бот`.
4. Відкрийте `https://api.telegram.org/bot<ТОКЕН>/getUpdates` і знайдіть `"chat":{"id":-…`. Це **chat_id** (з мінусом!).

> Не робіть групу публічною: бот показує, коли у вас немає світла, а `/status` доступний кожному учаснику.

### 5. Налаштуйте `src/config.ts`

Впишіть свої станції:

```ts
export const DEVICES: Device[] = [
	{ sn: 'D3M1…', name: 'Вітальня', via: 'rest', cmd: 'living' },
	{ sn: 'R655…', name: 'Роутер',   via: 'mqtt', cmd: 'router' },
]
export const GRID_SOURCE = 'R655…' // станція, по якій визначати світло
```

- `cmd` — латиницею, стане командою `/router` і кнопкою.
- `GRID_SOURCE` — найкраще станція з **постійним** навантаженням (роутер, ПК): світло визначається за її вхідною потужністю. Для `rest`-станцій — за входом AC.
- Там само пороги, тихий режим і часовий пояс.

### 6. Cloudflare

```bash
npx wrangler login                          # відкриє браузер → Allow
npx wrangler whoami                         # Account ID → знадобиться для секрету
npx wrangler kv namespace create POWER_KV   # виведе "id": "…"
```

У `wrangler.jsonc`:
- замініть `"name"` на своє ім'я воркера (латиниця, напр. `ecoflow-bot`);
- замініть `id` у `kv_namespaces` на той, що вивела команда.

**API-токен для GitHub:** dash.cloudflare.com → аватар → **My Profile → API Tokens → Create Token** → шаблон **Edit Cloudflare Workers** → *Account Resources*: ваш акаунт, *Zone Resources*: **All zones** → **Create Token**.

### 7. Секрети GitHub

Репозиторій → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Значення |
|---|---|
| `CLOUDFLARE_API_TOKEN` | токен з кроку 6 |
| `CLOUDFLARE_ACCOUNT_ID` | з `npx wrangler whoami` |
| `ECOFLOW_ACCESS_KEY` | крок 2 |
| `ECOFLOW_SECRET_KEY` | крок 2 |
| `EF_EMAIL` | email від застосунку EcoFlow (потрібен для `mqtt`-станцій) |
| `EF_PASSWORD` | пароль від застосунку EcoFlow |
| `TELEGRAM_BOT_TOKEN` | крок 4 |
| `TELEGRAM_CHAT_ID` | крок 4, з мінусом |
| `TG_WEBHOOK_SECRET` | будь-який випадковий рядок: `openssl rand -hex 32` |

Вставляйте без пробілів і переносів рядка. Всі 9 обов'язкові (`EF_*` можна заповнити будь-чим, якщо всі станції `rest`).

### 8. Деплой

```bash
git add . && git commit -m "My stations" && git push
```

**Actions → Deploy worker** має стати зеленим. Протягом 1–2 хв у групі з'явиться `📡 Моніторинг EcoFlow запущено` зі станом станцій і кнопками. Натисніть кнопку — має прийти статус.

Далі будь-яка зміна → `git push` → автодеплой.

---

## Якщо щось не так

Логи воркера в реальному часі:

```bash
npx wrangler tail
```

| Симптом | Причина / що робити |
|---|---|
| Actions: `Value for secret X not found` | не додано секрет `X` (перевірте, що це вкладка **Actions**, а не Codespaces/Dependabot) |
| `8521 signature is wrong` | ключі EcoFlow у секретах переплутані або з пробілами — вставте заново, Re-run |
| Повідомлень немає, кнопки не реагують | `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo`: якщо `url` порожній — крок деплою не дійшов до webhook; якщо Actions пише «Не вдалося визначити URL воркера» — додайте **змінну** (Variables, не Secrets) `WORKER_URL` = `https://<name>.<subdomain>.workers.dev` |
| Бот замовк після зміни налаштувань групи | група стала супергрупою, змінився chat_id (`-100…`) — оновіть `TELEGRAM_CHAT_ID` |
| `MQTT … CONNACK rc=4/5`, `EcoFlow login` | неправильний `EF_EMAIL`/`EF_PASSWORD` |
| Станція «❔ немає даних» | модель шле інший формат — зніміть дамп (нижче) і адаптуйте `src/protobuf.ts` / `readRest` |

### Інструменти діагностики (`tools/`)

- `tools/check-api.mjs` — які станції доступні через REST (крок 3).
- `tools/probe/probe.mjs` — 2 хв слухає MQTT і пише все в `probe-dump.jsonl` (з розібраним protobuf):

```bash
cd tools/probe && npm install
EF_EMAIL='...' EF_PASSWORD='...' node probe.mjs R655ZEBAXH170579 R655ZEBAXH171200
```

---

## Ліміти й вартість

Усе вкладається в безкоштовні тарифи з великим запасом:

| | Безкоштовно / добу | Використовується |
|---|---|---|
| Cloudflare Workers, запити | 100 000 | ~1 440 (cron) + натискання кнопок |
| Cloudflare KV, читання | 100 000 | ~6 000 |
| Cloudflare KV, записи | 1 000 | одиниці (лише при змінах) |
| GitHub Actions (приватний репо) | 2 000 хв/міс | ~1 хв на push |

Без прив'язаної карти списати гроші неможливо — у найгіршому разі воркер замовкне до кінця доби.

## Безпека

- Секрети зберігаються лише в GitHub Secrets і Cloudflare (зашифровано), у коді їх немає.
- `EF_PASSWORD` — пароль від акаунта EcoFlow: використовуйте унікальний.
- Бот відповідає лише в групі з `TELEGRAM_CHAT_ID`; webhook захищений `TG_WEBHOOK_SECRET`.
- MQTT-доступ неофіційний: EcoFlow може змінити протокол оновленням — тоді `tools/probe` допоможе розібратися.

## Структура

```
src/config.ts     ← ваші станції та налаштування
src/index.ts      cron, пороги, світло, Telegram, команди й кнопки
src/mqtt.ts       мінімальний MQTT-клієнт поверх TLS-сокетів Cloudflare
src/protobuf.ts   розбір protobuf-пакетів River 3
tools/            check-api, MQTT-зонд
wrangler.jsonc    ім'я воркера, cron, KV
.github/workflows/deploy.yml   деплой + реєстрація webhook
```
