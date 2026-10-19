// EcoFlow → Telegram: пороги розряду, світло, офлайн і команда /status.
// Маринка — офіційний IoT Open API; UPS (River 3) — MQTT застосунку EcoFlow.
// Cron раз на хвилину, стан у KV (пишемо лише при змінах, щоб влізти у free-ліміт).
import { mqttCollect, MqttAuthError } from './mqtt'
import { encodeRiver3Set, parseEcoflowPacket, type UpsPart } from './protobuf'

type Env = {
	POWER_KV: KVNamespace
	ECOFLOW_ACCESS_KEY: string
	ECOFLOW_SECRET_KEY: string
	EF_EMAIL: string
	EF_PASSWORD: string
	TELEGRAM_BOT_TOKEN: string
	TELEGRAM_CHAT_ID: string
	TG_WEBHOOK_SECRET: string
}

import { API, DEVICES, GRID_SOURCE, MQTT_WAIT_MS, OFFLINE_ALERT_MIN, QUIET_FROM, QUIET_TO, RESET_GAP, THRESHOLDS, TIMEZONE, type Device } from './config'

type Reading = { soc: number; remMin: number | null; loadW: number | null; gridIn: boolean | null; maxChg?: number; acMax?: number }
type DeviceState = { notified: number[]; offlineSince: number | null; offlineAlerted: boolean }
type GridState = { state: 'ON' | 'OFF'; since: number }

const emptyState = (): DeviceState => ({ notified: [], offlineSince: null, offlineAlerted: false })
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// ── EcoFlow IoT Open API (підписані запити) ─────────────────────
async function ecoflow(env: Env, path: string, params: Record<string, string> = {}) {
	const nonce = String(100000 + Math.floor(Math.random() * 900000))
	const timestamp = String(Date.now())
	const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
	const auth = `accessKey=${env.ECOFLOW_ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ECOFLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sign = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(query ? `${query}&${auth}` : auth)))
	const res = await fetch(`${API}${path}${query ? '?' + query : ''}`, { headers: { accessKey: env.ECOFLOW_ACCESS_KEY, nonce, timestamp, sign } })
	const json = await res.json<any>()
	if (json?.code !== '0') throw new Error(`EcoFlow ${path}: ${json?.code} ${json?.message}`)
	return json.data
}

async function readRest(env: Env, sn: string): Promise<Reading> {
	const q = await ecoflow(env, '/iot-open/sign/device/quota/all', { sn })
	const soc = Number(q.cmsBattSoc)
	if (!Number.isFinite(soc)) throw new Error(`${sn}: немає cmsBattSoc`)
	const loadW = Number(q.powOutSumW ?? 0)
	const acIn = Number(q.powGetAcIn ?? 0)
	const maxChg = Number(q.cmsMaxChgSoc)
	return {
		soc,
		loadW,
		gridIn: acIn > 0,
		remMin: loadW > 0 && acIn === 0 ? Number(q.cmsDsgRemTime) : null,
		maxChg: Number.isFinite(maxChg) ? maxChg : undefined,
	}
}

// ── Запис налаштувань через IoT Open API (PUT) ──────────────────
// Підпис: тіло «розплющується» у key=value (вкладені — через крапку), сортується, + accessKey/nonce/timestamp
const flatten = (o: any, prefix = ''): string[] =>
	Object.entries(o).flatMap(([k, v]) => {
		const key = prefix ? `${prefix}.${k}` : k
		if (Array.isArray(v)) return v.flatMap((x, i) => (typeof x === 'object' ? flatten(x, `${key}[${i}]`) : [`${key}[${i}]=${x}`]))
		return v !== null && typeof v === 'object' ? flatten(v, key) : [`${key}=${v}`]
	})

async function ecoflowSet(env: Env, sn: string, params: Record<string, number | boolean>) {
	// Конверт для DELTA 3 / Stream: cmdId 17, cmdFunc 254, dest 2
	const body = { sn, cmdId: 17, cmdFunc: 254, dirDest: 1, dirSrc: 1, dest: 2, needAck: true, params }
	const nonce = String(100000 + Math.floor(Math.random() * 900000))
	const timestamp = String(Date.now())
	const toSign = [...flatten(body).sort(), `accessKey=${env.ECOFLOW_ACCESS_KEY}`, `nonce=${nonce}`, `timestamp=${timestamp}`].join('&')
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ECOFLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sign = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign)))
	const res = await fetch(`${API}/iot-open/sign/device/quota`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json;charset=UTF-8', accessKey: env.ECOFLOW_ACCESS_KEY, nonce, timestamp, sign },
		body: JSON.stringify(body),
	})
	const json = await res.json<any>()
	if (json?.code !== '0') throw new Error(`EcoFlow set: ${json?.code} ${json?.message}`)
}

// Дії з кнопок: callback_data = "set:<cmd>:<дія>"
// for — для якого типу станції кнопка (як via у config.ts);
// kind 'rest' — параметри IoT Open API; kind 'mqtt' — поле SetCommand (protobuf, однакове для DELTA 3 і River 3)
type Action = { label: string; group: string; for: Device['via'] } & (
	| { kind: 'rest'; params: Record<string, number> }
	| { kind: 'mqtt'; field: number; value: number }
)
const ACTIONS: Record<string, Action> = {
	// DELTA 3 (офіційний API)
	max80: { label: '80%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 80 } },
	max100: { label: '100%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 100 } },
	ac500: { label: '500 Вт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', field: 54, value: 500 }, // API ігнорує → MQTT
	ac1000: { label: '1 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', field: 54, value: 1000 }, // API ігнорує → MQTT
	ac2000: { label: '2 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', field: 54, value: 2000 }, // API ігнорує → MQTT
	// River 3 (MQTT; макс. вхід від мережі ~305 Вт)
	rmax80: { label: '80%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', field: 33, value: 80 },
	rmax100: { label: '100%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', field: 33, value: 100 },
	rac100: { label: '100 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', field: 54, value: 100 },
	rac200: { label: '200 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', field: 54, value: 200 },
	rac300: { label: '300 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', field: 54, value: 300 },
}

// Запис у River 3 через MQTT застосунку; успіх — якщо станція відповіла set_reply
async function mqttSet(env: Env, sn: string, field: number, value: number) {
	const a = await appAuth(env)
	let replied = false
	await mqttCollect({
		host: a.host,
		port: a.port,
		username: a.username,
		password: a.password,
		clientId: `ANDROID_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}_${a.userId}`,
		topics: [`/app/${a.userId}/${sn}/thing/property/set_reply`],
		publish: [{ topic: `/app/${a.userId}/${sn}/thing/property/set`, payload: encodeRiver3Set(sn, field, value) }],
		timeoutMs: 8000,
		onMessage: () => (replied = true),
	})
	if (!replied) throw new Error('станція не підтвердила команду за 8 с')
}

const runAction = (env: Env, d: Device, a: Action) => (a.kind === 'rest' ? ecoflowSet(env, d.sn, a.params) : mqttSet(env, d.sn, a.field, a.value))

// ── MQTT застосунку (для River 3) ───────────────────────────────
type AppAuth = { host: string; port: number; username: string; password: string; userId: string }

async function appAuth(env: Env): Promise<AppAuth> {
	const cached = await env.POWER_KV.get<AppAuth>('appauth', 'json')
	if (cached) return cached
	const lr = await fetch(`${API}/auth/login`, {
		method: 'POST',
		headers: { lang: 'en_US', 'content-type': 'application/json' },
		body: JSON.stringify({ email: env.EF_EMAIL, password: btoa(env.EF_PASSWORD), scene: 'IOT_APP', userType: 'ECOFLOW' }),
	})
	const lj = await lr.json<any>()
	if (lj.code !== '0') throw new Error(`EcoFlow login: ${lj.code} ${lj.message}`)
	const userId = String(lj.data.user.userId)
	const cr = await fetch(`${API}/iot-auth/app/certification?userId=${userId}`, { headers: { lang: 'en_US', authorization: `Bearer ${lj.data.token}` } })
	const cj = await cr.json<any>()
	if (cj.code !== '0') throw new Error(`EcoFlow certification: ${cj.code} ${cj.message}`)
	const a: AppAuth = { host: cj.data.url, port: Number(cj.data.port), username: cj.data.certificateAccount, password: cj.data.certificatePassword, userId }
	await env.POWER_KV.put('appauth', JSON.stringify(a), { expirationTtl: 12 * 3600 })
	return a
}

async function readMqtt(env: Env, sns: string[]): Promise<Map<string, Reading>> {
	const result = new Map<string, Reading>()
	if (!sns.length) return result
	const a = await appAuth(env)
	const parts = new Map<string, UpsPart>(sns.map((sn) => [sn, {}]))
	try {
		await mqttCollect({
			host: a.host,
			port: a.port,
			username: a.username,
			password: a.password,
			clientId: `ANDROID_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}_${a.userId}`,
			topics: sns.map((sn) => `/app/device/property/${sn}`),
			// «Будимо» станції запитом як у застосунку — без нього River 3 може не слати телеметрію
			publish: sns.map((sn) => ({
				topic: `/app/${a.userId}/${sn}/thing/property/get`,
				payload: new TextEncoder().encode(
					JSON.stringify({ from: 'Android', id: String(Date.now() % 1e9), version: '1.1', moduleType: 0, operateType: 'latestQuotas', params: {} }),
				),
			})),
			timeoutMs: MQTT_WAIT_MS,
			onMessage: ({ topic, payload }) => {
				const sn = sns.find((s) => topic.endsWith(s))
				if (!sn) return false
				try {
					Object.assign(parts.get(sn)!, parseEcoflowPacket(payload))
				} catch (e) {
					console.warn('parse', sn, e)
				}
				// вистачає, коли від кожної UPS є BMS-пакет (заряд)
				return sns.every((s) => parts.get(s)!.soc !== undefined)
			},
		})
	} catch (e) {
		if (e instanceof MqttAuthError) await env.POWER_KV.delete('appauth')
		throw e
	}
	for (const [sn, p] of parts) {
		if (p.soc === undefined) continue
		const discharging = (p.battOutW ?? 0) > 5 && (p.battInW ?? 0) === 0
		// вхід відомий лише з 254/21; інакше — якщо батарея не розряджається, живимось від мережі
		const gridIn = p.inSumW !== undefined ? p.inSumW > 1 : !discharging
		result.set(sn, {
			soc: Math.round(p.soc),
			remMin: discharging && p.remMin !== undefined ? p.remMin : null,
			loadW: p.outSumW !== undefined ? Math.round(p.outSumW) : discharging ? (p.battOutW ?? null) : null,
			gridIn,
			maxChg: p.maxChg,
			acMax: p.acMax,
		})
	}
	return result
}

// ── Збір даних з усіх станцій ───────────────────────────────────
async function readAll(env: Env, devices: Device[] = DEVICES) {
	const list: Array<{ sn: string; online: number }> = await ecoflow(env, '/iot-open/sign/device/list')
	const online = new Map(DEVICES.map((d) => [d.sn, list.find((x) => x.sn === d.sn)?.online === 1]))
	const readings = new Map<string, Reading>()
	const errors: string[] = []

	const restJobs = devices.filter((d) => d.via === 'rest' && online.get(d.sn)).map(async (d) => {
		try {
			readings.set(d.sn, await readRest(env, d.sn))
		} catch (e) {
			errors.push(`${d.name}: ${e}`)
		}
	})
	const mqttJob = (async () => {
		try {
			const want = devices.filter((d) => d.via === 'mqtt' && online.get(d.sn))
			const r = await readMqtt(env, want.map((d) => d.sn))
			for (const [sn, v] of r) readings.set(sn, v)
			const missing = want.filter((d) => !r.has(d.sn)).map((d) => d.name)
			if (missing.length) errors.push(`${missing.join(', ')}: станція не надіслала дані за ${MQTT_WAIT_MS / 1000} с`)
		} catch (e) {
			errors.push(`MQTT: ${e}`)
		}
	})()
	await Promise.all([...restJobs, mqttJob])
	for (const e of errors) console.error(e)
	return { online, readings, errors }
}

// ── Telegram ────────────────────────────────────────────────────
// Головні кнопки: стан + перехід у «папку» керування
const KEYBOARD = {
	inline_keyboard: [
		[{ text: '📊 Усі станції', callback_data: 'status' }],
		DEVICES.map((d) => ({ text: d.name, callback_data: d.cmd })),
		[{ text: '⚙️ Керування', callback_data: 'menu:control' }],
	],
}

// «Папка» керування: спершу вибір станції…
const CONTROL_KEYBOARD = {
	inline_keyboard: [
		DEVICES.filter((d) => Object.values(ACTIONS).some((a) => a.for === d.via)).map((d) => ({ text: d.name, callback_data: `menu:dev:${d.cmd}` })),
		[{ text: '⬅️ Назад', callback_data: 'menu:main' }],
	],
}
// …потім усі команди станції, згруповані рядками
const deviceKeyboard = (d: Device) => {
	const groups = new Map<string, { text: string; callback_data: string }[]>()
	for (const [id, a] of Object.entries(ACTIONS)) {
		if (a.for !== d.via) continue
		if (!groups.has(a.group)) groups.set(a.group, [])
		groups.get(a.group)!.push({ text: a.label, callback_data: `set:${d.cmd}:${id}` })
	}
	return {
		inline_keyboard: [
			...[...groups].flatMap(([g, row]) => [[{ text: `${g} · ${d.name}`, callback_data: 'noop' }], row]),
			[
				{ text: '⬅️ Станції', callback_data: 'menu:control' },
				{ text: '🏠 Головна', callback_data: 'menu:main' },
			],
		],
	}
}

async function tgCall(env: Env, method: string, body: object) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`)
	return (await res.json<any>()).result
}

const kyivHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
const isQuiet = () => {
	const h = kyivHour()
	return QUIET_FROM < QUIET_TO ? h >= QUIET_FROM && h < QUIET_TO : h >= QUIET_FROM || h < QUIET_TO
}

type SendOpts = { chatId?: string | number; loud?: boolean; keyboard?: boolean }

// HTML-повідомлення; уночі — без звуку (якщо не loud); кнопки лише на панелі стану
// Явний роздільник у кінці кожного повідомлення, щоб сусідні не зливались
// U+2800 (порожній символ Брайля) Telegram не обрізає — дає «повітря» внизу бульбашки
const DIVIDER = '\u2800'

// TELEGRAM_CHAT_ID може містити кілька груп через кому: "-555…,-401…"
const chatIds = (env: Env) => env.TELEGRAM_CHAT_ID.split(',').map((x) => x.trim()).filter(Boolean)
const isOurChat = (env: Env, id: unknown) => chatIds(env).includes(String(id))

// Відповідь у конкретний чат (o.chatId) або розсилка в усі групи; збій однієї групи не блокує інші
async function telegram(env: Env, text: string, o: SendOpts = {}) {
	const targets = o.chatId !== undefined ? [o.chatId] : chatIds(env)
	const results = await Promise.allSettled(
		targets.map((chat_id) =>
			tgCall(env, 'sendMessage', {
				chat_id,
				text: `${text}\n${DIVIDER}`,
				parse_mode: 'HTML',
				link_preview_options: { is_disabled: true },
				disable_notification: !o.loud && isQuiet(),
				...(o.keyboard ? { reply_markup: KEYBOARD } : {}),
			}),
		),
	)
	const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
	for (const f of failed) console.error('telegram', f.reason)
	if (failed.length === results.length) throw failed[0].reason
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hhmm = (minutes: number) => {
	const m = Math.max(0, Math.round(minutes))
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const duration = (ms: number) => {
	const m = Math.floor(ms / 60000)
	return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год ${m % 60} хв`
}
const clock = (t: number, sec = false) =>
	new Date(t).toLocaleTimeString('uk-UA', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) })
const socIcon = (soc: number) => (soc <= 10 ? '🚨' : soc <= 25 ? '🪫' : '🔋')
const bar = (soc: number) => {
	const n = Math.max(0, Math.min(10, Math.round(soc / 10)))
	return '▰'.repeat(n) + '▱'.repeat(10 - n)
}


type Panel = { text: string; device?: Device }

// Стан станції одним рядком: «⏳ 04:01 · ⚡ 58 Вт» / «🔌 від мережі»
const stateLine = (r: Reading) => {
	const load = r.loadW !== null ? ` · ⚡ ${r.loadW} Вт` : ''
	return r.remMin !== null ? `⏳ ${hhmm(r.remMin)}${load}` : r.gridIn ? `🔌 від мережі${load}` : `⏳ —${load}`
}

// Список станцій звичайним текстом: кожна — міні-блок «назва + %» і «шкала · прогноз · навантаження»,
// між станціями порожній рядок
const table = (devices: Device[], readings: Map<string, Reading>, online: Map<string, boolean>) =>
	devices
		.map((d) => {
			const name = `<b>${esc(d.name)}</b>`
			const r = readings.get(d.sn)
			if (!online.get(d.sn)) return `⚫️ ${name} — офлайн`
			if (!r) return `❔ ${name} — немає даних`
			return `${socIcon(r.soc)} ${name}  <b>${r.soc}%</b>\n<code>${bar(r.soc)}</code>  ${stateLine(r)}`
		})
		.join('\n\n')

// Рядок про світло — простим текстом під блоком
const gridText = (g: GridState | null, now: number) =>
	!g ? '' : g.state === 'ON' ? `💡 Світло є з ${clock(g.since)}` : `🕯 Без світла ${duration(now - g.since)} · з ${clock(g.since)}`

// Детальна картка однієї станції: усе звичайним текстом, світло — окремим рядком знизу
const card = (d: Device, r: Reading | undefined, isOnline: boolean, g: GridState | null, now: number) => {
	const head = `<b>${esc(d.name)}</b>   <i>${clock(now)}</i>`
	const g_ = gridText(g, now)
	const foot = g_ ? `\n\n${g_}` : ''
	if (!isOnline) return `⚫️ ${head}\nОфлайн${foot}`
	if (!r) return `❔ ${head}\nНемає даних${foot}`
	const time =
		r.remMin !== null ? `⏳ Залишилось  <b>${hhmm(r.remMin)}</b>` : r.gridIn ? `🔌 <b>Від мережі</b>` : `⏳ Залишилось  <b>—</b>`
	const load = r.loadW !== null ? `\n⚡ Споживання  <b>${r.loadW} Вт</b>` : ''
	const lim =
		(r.maxChg !== undefined ? `\n🔝 Ліміт заряду  <b>${r.maxChg}%</b>` : '') +
		(r.acMax !== undefined ? `\n🔌 Макс. вхід  <b>${r.acMax} Вт</b>` : '')
	return `${socIcon(r.soc)} ${head}\n<code>${bar(r.soc)}</code>  <b>${r.soc}%</b>\n${time}${load}${lim}${foot}`
}

async function statusPanel(env: Env, devices: Device[] = DEVICES): Promise<Panel> {
	const { online, readings, errors } = await readAll(env, devices)
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	// якщо дані не прийшли — показуємо причину, а не просто «немає даних»
	const errs = errors.length ? `\n\n<i>⚠️ ${esc(errors.join('; ').slice(0, 300))}</i>` : ''
	if (devices.length === 1) {
		const d = devices[0]
		return { text: card(d, readings.get(d.sn), online.get(d.sn)!, grid, now) + errs, device: d }
	}
	const g_ = gridText(grid, now)
	const foot = g_ ? `\n\n${g_}` : ''
	return { text: `📊 <b>Станції</b>   <i>${clock(now)}</i>\n\n${table(devices, readings, online)}${foot}${errs}` }
}

// ── Кнопки лише під останньою панеллю ──
// id останньої панелі в кожному чаті тримаємо в Cache API (безкоштовно, не витрачає ліміт записів KV)
const panelKey = (chatId: string | number) => new Request(`https://panel.local/${chatId}`)
const noKeyboard = (env: Env, chatId: string | number, messageId: number) =>
	tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})

async function sendPanel(env: Env, chatId: string | number, p: Panel) {
	const cache = caches.default
	const prev = await cache.match(panelKey(chatId))
	if (prev) await noKeyboard(env, chatId, Number(await prev.text()))
	const msg = await tgCall(env, 'sendMessage', {
		chat_id: chatId,
		text: `${p.text}\n${DIVIDER}`,
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: true },
		disable_notification: isQuiet(),
		reply_markup: KEYBOARD,
	})
	if (msg?.message_id)
		await cache.put(panelKey(chatId), new Response(String(msg.message_id), { headers: { 'Cache-Control': 'max-age=604800' } }))
}

// ── Щохвилинна перевірка ────────────────────────────────────────
async function checkDevice(env: Env, dev: Device, isOnline: boolean, r: Reading | undefined) {
	const kvKey = `dev:${dev.sn}`
	const raw = await env.POWER_KV.get(kvKey)
	const st: DeviceState = raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState()
	const before = JSON.stringify(st)
	const now = Date.now()

	if (!isOnline) {
		st.offlineSince ??= now
		if (!st.offlineAlerted && now - st.offlineSince >= OFFLINE_ALERT_MIN * 60000) {
			await telegram(env, `⚠️ <b>${esc(dev.name)} — немає зв'язку</b>\nВже ${duration(now - st.offlineSince)}. Сповіщення про заряд не працюють.`)
			st.offlineAlerted = true
		}
	} else {
		if (st.offlineAlerted) await telegram(env, `✅ <b>${esc(dev.name)}</b> знову на зв'язку`)
		st.offlineSince = null
		st.offlineAlerted = false

		if (r) {
			const crossed = THRESHOLDS.filter((t) => r.soc <= t && !st.notified.includes(t))
			if (crossed.length) {
				const t = Math.min(...crossed)
				const loud = t === Math.min(...THRESHOLDS)
				const rem = r.remMin !== null ? `⏳ Залишилось ≈ <b>${hhmm(r.remMin)}</b>` : r.gridIn ? '🔌 Від мережі' : '⏳ Час невідомий'
				const load = r.loadW !== null ? `\n⚡ Споживання ${r.loadW} Вт` : ''
				const custom = dev.messages?.[t] ? `\n💬 <i>${esc(dev.messages[t])}</i>` : ''
				await telegram(env, `${socIcon(t)} <b>${esc(dev.name)} — ${r.soc}%</b>${custom}\n<code>${bar(r.soc)}</code>\n${rem}${load}`, { loud })
				st.notified.push(...crossed)
			}
			st.notified = st.notified.filter((t) => r.soc < t + RESET_GAP)
		}
	}
	if (JSON.stringify(st) !== before) await env.POWER_KV.put(kvKey, JSON.stringify(st))
}

async function checkGrid(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>) {
	const src = readings.get(GRID_SOURCE)
	if (!src || src.gridIn === null) return // невідомо — нічого не міняємо
	const now = Date.now()
	const cur: GridState['state'] = src.gridIn ? 'ON' : 'OFF'
	const prev = await env.POWER_KV.get<GridState>('grid', 'json')
	if (prev?.state === cur) return
	await env.POWER_KV.put('grid', JSON.stringify({ state: cur, since: now }))
	if (!prev) return // перший запуск — просто запам'ятали
	const t = table(DEVICES, readings, online)
	if (cur === 'OFF') await telegram(env, `<b>🕯 Світло пішло</b>   <i>${clock(now)}</i>\n\n${t}`)
	else await telegram(env, `<b>💡 Світло повернулось</b> · не було ${duration(now - prev.since)}   <i>${clock(now)}</i>\n\n${t}`)
}

// Меню команд у Telegram будується з config.ts і оновлюється лише при змінах
async function syncCommands(env: Env) {
	const commands = [
		{ command: 'status', description: 'Усі станції: заряд і час роботи' },
		...DEVICES.map((d) => ({ command: d.cmd, description: d.name })),
		{ command: 'help', description: 'Список команд' },
	]
	const json = JSON.stringify(commands)
	if ((await env.POWER_KV.get('commands')) === json) return
	await tgCall(env, 'setMyCommands', { commands })
	await env.POWER_KV.put('commands', json)
}

async function run(env: Env) {
	await syncCommands(env).catch((e) => console.error('commands', e))
	const { online, readings } = await readAll(env)
	if (!(await env.POWER_KV.get('started:v3'))) {
		const text = `📡 <b>Моніторинг EcoFlow запущено</b>\nПороги ${THRESHOLDS.join(' · ')}% · тиша ${QUIET_FROM}:00–${QUIET_TO}:00\n\n${table(DEVICES, readings, online)}`
		for (const id of chatIds(env)) await sendPanel(env, id, { text }).catch((e) => console.error('start', id, e))
		await env.POWER_KV.put('started:v3', String(Date.now()))
	}
	for (const d of DEVICES) {
		try {
			await checkDevice(env, d, online.get(d.sn)!, readings.get(d.sn))
		} catch (e) {
			console.error(d.name, e)
		}
	}
	await checkGrid(env, readings, online)
}

// ── Telegram webhook: команди і кнопки ──────────────────────────
async function helpText() {
	const list = DEVICES.map((d) => `/${d.cmd} — ${esc(d.name)}`).join('\n')
	return `<b>🤖 Команди</b>\n/status — усі станції\n${list}\n\nАбо кнопки нижче.`
}

async function render(env: Env, cmd: string): Promise<Panel | null> {
	if (cmd === 'help' || cmd === 'start') return { text: await helpText() }
	const devices = cmd === 'status' ? DEVICES : DEVICES.filter((d) => d.cmd === cmd)
	if (!devices.length) return null
	try {
		return await statusPanel(env, devices)
	} catch (e) {
		console.error('status', e)
		return { text: `⚠️ <b>Не вдалося отримати дані</b>\n${esc(String(e))}` }
	}
}

async function handleUpdate(env: Env, update: any) {
	const cb = update?.callback_query
	if (cb) {
		const chatId = cb.message?.chat?.id
		const ours = isOurChat(env, chatId)
		const data = String(cb.data)
		// Навігація між «папками» — міняємо лише кнопки під тим самим повідомленням
		if (data === 'noop' || data.startsWith('menu:')) {
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {})
			if (!ours || data === 'noop') return
			const dev = data.startsWith('menu:dev:') ? DEVICES.find((x) => x.cmd === data.slice(9)) : undefined
			const markup = dev ? deviceKeyboard(dev) : data === 'menu:control' ? CONTROL_KEYBOARD : KEYBOARD
			await tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: markup }).catch(() => {})
			return
		}
		if (ours && data.startsWith('set:')) {
			const [, cmd, actionId] = data.split(':')
			const d = DEVICES.find((x) => x.cmd === cmd)
			const action = ACTIONS[actionId]
			if (!d || !action || action.for !== d.via) return
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Надсилаю команду…' }).catch(() => {})
			let note: string
			try {
				await runAction(env, d, action)
				note = `✅ ${d.name}: ${action.group.replace(/^\S+\s/, '').toLowerCase()} ${action.label}`
			} catch (e) {
				console.error('set', e)
				note = `⚠️ Не вдалося: ${String(e).replace(/^Error:\s*/, '').slice(0, 150)}`
			}
			await new Promise((r) => setTimeout(r, 3000)) // станції потрібен час, щоб застосувати
			const panel = await render(env, d.cmd)
			if (panel) {
				panel.text = `${esc(note)}\n\n${panel.text}`
				await noKeyboard(env, chatId, cb.message.message_id)
				await sendPanel(env, chatId, panel)
			}
			return
		}
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: ours ? 'Оновлюю…' : undefined }).catch(() => {})
		if (!ours) return
		const panel = await render(env, data)
		if (!panel) return
		// Нове повідомлення з кнопками; старе лишається в історії, з нього прибираємо лише кнопки
		await noKeyboard(env, chatId, cb.message.message_id) // на випадок, якщо кеш порожній
		await sendPanel(env, chatId, panel)
		return
	}
	const msg = update?.message
	const cmd = (msg?.text ?? '').match(/^\/(\w+)(@\w+)?(\s|$)/)?.[1]?.toLowerCase()
	if (!cmd) return
	if (!isOurChat(env, msg.chat.id)) return // лише наші групи
	const panel = await render(env, cmd)
	if (panel) await sendPanel(env, msg.chat.id, panel)
}

export default {
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(run(env))
	},
	async fetch(req, env, ctx) {
		const url = new URL(req.url)
		if (url.pathname === '/telegram' && req.method === 'POST') {
			if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 })
			ctx.waitUntil(handleUpdate(env, await req.json()))
			return new Response('ok')
		}
		return new Response('ok')
	},
} satisfies ExportedHandler<Env>
