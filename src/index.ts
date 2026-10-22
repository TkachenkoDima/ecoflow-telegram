// EcoFlow → Telegram: пороги розряду, світло, офлайн і команда /status.
// Маринка — офіційний IoT Open API; UPS (River 3) — MQTT застосунку EcoFlow.
// Cron раз на хвилину, стан у KV (пишемо лише при змінах, щоб влізти у free-ліміт).
import { mqttCollect, MqttAuthError } from './mqtt'
import { encodeSetCommand, parseEcoflowPacket, type UpsPart } from './protobuf'

type Env = {
	POWER_KV: KVNamespace
	ECOFLOW_ACCESS_KEY: string
	ECOFLOW_SECRET_KEY: string
	EF_EMAIL: string
	EF_PASSWORD: string
	TELEGRAM_BOT_TOKEN: string
	TELEGRAM_CHAT_ID: string
	TG_WEBHOOK_SECRET: string
	DEVICE_SNS: string // {"marinka": "D3M1…", "kate": "R655…"} — серійники не зберігаються в репо
}

import { API, AUTOMATIONS, DEVICES, GRID_SOURCE, MQTT_WAIT_MS, OFFLINE_ALERT_MIN, QUIET_FROM, QUIET_TO, RESET_GAP, THRESHOLDS, TIMEZONE, type Device } from './config'

// Підставляємо серійники з секрету DEVICE_SNS (за cmd станції)
function initDevices(env: Env) {
	let map: Record<string, string>
	try {
		map = JSON.parse(env.DEVICE_SNS || '{}')
	} catch {
		throw new Error('DEVICE_SNS: невалідний JSON')
	}
	for (const d of DEVICES) {
		d.sn = map[d.cmd] ?? ''
		if (!d.sn) throw new Error(`DEVICE_SNS: немає серійника для "${d.cmd}"`)
	}
}
const gridSn = () => DEVICES.find((d) => d.cmd === GRID_SOURCE)?.sn ?? ''

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
	| { kind: 'mqtt'; fields: [number, number][] }
)
const ACTIONS: Record<string, Action> = {
	// DELTA 3 (офіційний API)
	max80: { label: '80%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 80 } },
	max100: { label: '100%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 100 } },
	ac500: { label: '500 Вт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 500], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	ac1000: { label: '1 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 1000], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	ac2000: { label: '2 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 2000], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	// River 3 (MQTT; макс. вхід від мережі ~305 Вт)
	rmax80: { label: '80%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', fields: [[33, 80]] },
	rmax100: { label: '100%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', fields: [[33, 100]] },
	rac100: { label: '100 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', fields: [[54, 100]] },
	rac200: { label: '200 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', fields: [[54, 200]] },
	rac300: { label: '300 Вт', group: '🔌 Вхідна потужність', for: 'mqtt', kind: 'mqtt', fields: [[54, 300]] },
}

// Запис через MQTT застосунку. Підтвердження — будь-що з двох:
//  1) відповідь станції set_reply;
//  2) у телеметрії з'явилось нове значення (33 → поле 270 «ліміт заряду», 54 → поле 209 «макс. вхід»).
// Якщо за 10 с нічого — «надіслано без підтвердження» (команда при цьому часто застосовується).
async function mqttSet(env: Env, sn: string, fields: [number, number][]): Promise<boolean> {
	const a = await appAuth(env)
	const want = new Map(fields)
	const expectMax = want.get(33)
	const expectAc = want.get(54)
	let confirmed = false
	await mqttCollect({
		host: a.host,
		port: a.port,
		username: a.username,
		password: a.password,
		clientId: `ANDROID_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}_${a.userId}`,
		topics: [`/app/${a.userId}/${sn}/thing/property/set_reply`, `/app/device/property/${sn}`],
		publish: [{ topic: `/app/${a.userId}/${sn}/thing/property/set`, payload: encodeSetCommand(sn, fields) }],
		timeoutMs: 10_000,
		onMessage: ({ topic, payload }) => {
			if (topic.endsWith('/set_reply')) return (confirmed = true)
			try {
				const p = parseEcoflowPacket(payload)
				if ((expectMax !== undefined && p.maxChg === expectMax) || (expectAc !== undefined && p.acMax === expectAc)) confirmed = true
			} catch {}
			return confirmed
		},
	})
	return confirmed
}

// true — підтверджено; false — надіслано без підтвердження
const runAction = async (env: Env, d: Device, a: Action) => (a.kind === 'rest' ? (await ecoflowSet(env, d.sn, a.params), true) : mqttSet(env, d.sn, a.fields))

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

// ── Налаштування станцій (ліміт заряду, макс. вхід) у KV — спільні для всіх дата-центрів Cloudflare ──
// Запис лише коли значення змінилось або минула година (≈ до 72 записів/добу на 3 станції — далеко від ліміту 1000)
type Settings = { maxChg?: number; acMax?: number; at: number; cmdAt?: number } // cmdAt — коли змінено командою бота
const RECENT_CMD_MS = 10 * 60_000
const SETTINGS_FRESH_MS = 60 * 60_000
let settingsEnv: Env // KV доступний лише через env — запам'ятовуємо на час запиту
const settingsCache = new Map<string, Settings | null>() // у межах одного запуску, щоб не читати KV двічі
async function getSettings(sn: string): Promise<Settings | null> {
	if (!settingsCache.has(sn)) settingsCache.set(sn, await settingsEnv.POWER_KV.get<Settings>(`settings:${sn}`, 'json'))
	return settingsCache.get(sn)!
}
async function saveSettings(sn: string, upd: { maxChg?: number; acMax?: number }, byCommand = false) {
	if (upd.maxChg === undefined && upd.acMax === undefined) return
	const prev = await getSettings(sn)
	const next: Settings = {
		maxChg: upd.maxChg ?? prev?.maxChg,
		acMax: upd.acMax ?? prev?.acMax,
		at: Date.now(),
		cmdAt: byCommand ? Date.now() : prev?.cmdAt,
	}
	const changed = !prev || prev.maxChg !== next.maxChg || prev.acMax !== next.acMax
	if (!byCommand && !changed && Date.now() - prev.at < SETTINGS_FRESH_MS) return
	settingsCache.set(sn, next)
	await settingsEnv.POWER_KV.put(`settings:${sn}`, JSON.stringify(next))
}

// sns — з кого читаємо заряд; settingsFor — у кого ще чекаємо налаштування (повний пакет 254/21:
// ліміт заряду і макс. вхід); restSettings — REST-станції, з яких по MQTT беремо лише макс. вхід
async function readMqtt(
	env: Env,
	sns: string[],
	o: { settingsFor?: string[]; restSettings?: string[]; timeoutMs?: number } = {},
): Promise<{ result: Map<string, Reading>; parts: Map<string, UpsPart> }> {
	const result = new Map<string, Reading>()
	const settingsFor = new Set(o.settingsFor ?? [])
	const restOnly = o.restSettings ?? []
	const all = [...sns, ...restOnly]
	if (!all.length) return { result, parts: new Map() }
	const a = await appAuth(env)
	const parts = new Map<string, UpsPart>(all.map((sn) => [sn, {}]))
	const ready = (sn: string) => {
		const p = parts.get(sn)!
		if (restOnly.includes(sn)) return p.acMax !== undefined
		if (p.soc === undefined) return false
		return !settingsFor.has(sn) || (p.maxChg !== undefined && p.acMax !== undefined)
	}
	try {
		await mqttCollect({
			host: a.host,
			port: a.port,
			username: a.username,
			password: a.password,
			clientId: `ANDROID_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}_${a.userId}`,
			topics: all.map((sn) => `/app/device/property/${sn}`),
			// «Будимо» станції запитом як у застосунку — без нього River 3 може не слати телеметрію
			publish: all.map((sn) => ({
				topic: `/app/${a.userId}/${sn}/thing/property/get`,
				payload: new TextEncoder().encode(
					JSON.stringify({ from: 'Android', id: String(Date.now() % 1e9), version: '1.1', moduleType: 0, operateType: 'latestQuotas', params: {} }),
				),
			})),
			timeoutMs: o.timeoutMs ?? MQTT_WAIT_MS,
			onMessage: ({ topic, payload }) => {
				const sn = all.find((s) => topic.endsWith(s))
				if (!sn) return false
				try {
					Object.assign(parts.get(sn)!, parseEcoflowPacket(payload))
				} catch (e) {
					console.warn('parse', sn, e)
				}
				// досить, коли від кожної станції є все потрібне
				return all.every(ready)
			},
		})
	} catch (e) {
		if (e instanceof MqttAuthError) await env.POWER_KV.delete('appauth')
		throw e
	}
	// усе, що побачили з налаштувань, — у кеш
	await Promise.all([...parts].map(([sn, p]) => saveSettings(sn, { maxChg: restOnly.includes(sn) ? undefined : p.maxChg, acMax: p.acMax })))
	for (const [sn, p] of parts) {
		if (p.soc === undefined || restOnly.includes(sn)) continue
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
	return { result, parts }
}

// ── Збір даних з усіх станцій ───────────────────────────────────
// detailed — картка однієї станції: додаємо налаштування з кешу (живі мають пріоритет)
// refresh — cron: якщо налаштування в кеші застаріли, чекаємо повний пакет телеметрії довше
async function readAll(env: Env, devices: Device[] = DEVICES, detailed = false, refresh = false) {
	const list: Array<{ sn: string; online: number }> = await ecoflow(env, '/iot-open/sign/device/list')
	const online = new Map(DEVICES.map((d) => [d.sn, list.find((x) => x.sn === d.sn)?.online === 1]))
	const readings = new Map<string, Reading>()
	const errors: string[] = []

	const restJobs = devices.filter((d) => d.via === 'rest' && online.get(d.sn)).map(async (d) => {
		try {
			const rd = await readRest(env, d.sn)
			// Хмарний API віддає налаштування з запізненням (хвилини). Якщо бот сам щойно змінив ліміт —
			// 10 хв довіряємо своєму значенню, а не старому з API
			const c = await getSettings(d.sn)
			const recent = c?.cmdAt !== undefined && Date.now() - c.cmdAt < RECENT_CMD_MS
			if (recent && c?.maxChg !== undefined) rd.maxChg = c.maxChg
			else await saveSettings(d.sn, { maxChg: rd.maxChg })
			readings.set(d.sn, rd)
		} catch (e) {
			errors.push(`${d.name}: ${e}`)
		}
	})
	const mqttJob = (async () => {
		try {
			const want = devices.filter((d) => d.via === 'mqtt' && online.get(d.sn))
			const stale = async (sn: string) => {
				const c = await getSettings(sn)
				return !c || Date.now() - c.at > SETTINGS_FRESH_MS
			}
			// cron: оновлюємо застарілі; картка: чекаємо наживо лише тих, кого ще немає в кеші
			// (кеш Cloudflare — на рівні дата-центру, тож картка й cron можуть його не ділити)
			const need = async (sn: string) => (refresh ? stale(sn) : detailed ? !(await getSettings(sn)) : false)
			const pick = async (list: Device[]) => (await Promise.all(list.map(async (d) => ((await need(d.sn)) ? d.sn : '')))).filter(Boolean)
			const settingsFor = await pick(want)
			// REST-станції (DELTA 3) не шлють налаштування в MQTT-телеметрії — не чекаємо їх;
			// їхній «макс. вхід» запам'ятовується, коли його виставляють кнопкою з «Керування»
			const restSet: string[] = []
			const { result: r, parts } = await readMqtt(env, want.map((d) => d.sn), {
				settingsFor,
				restSettings: restSet,
				timeoutMs: refresh && (settingsFor.length || restSet.length) ? 25_000 : MQTT_WAIT_MS,
			})
			for (const [sn, v] of r) readings.set(sn, v)
			// макс. вхід для REST-станцій (офіційний API його не віддає) — дописуємо після REST
			await Promise.all(restJobs)
			for (const sn of restSet) {
				const ac = parts.get(sn)?.acMax
				const rd = readings.get(sn)
				if (rd && ac !== undefined) rd.acMax = ac
			}
			const missing = want.filter((d) => !r.has(d.sn)).map((d) => d.name)
			if (missing.length) errors.push(`${missing.join(', ')}: станція не надіслала дані за ${MQTT_WAIT_MS / 1000} с`)
		} catch (e) {
			errors.push(`MQTT: ${e}`)
		}
	})()
	await Promise.all([...restJobs, mqttJob])
	if (detailed)
		for (const d of devices) {
			const rd = readings.get(d.sn)
			const c = rd ? await getSettings(d.sn) : null
			if (rd && c) {
				rd.maxChg ??= c.maxChg
				rd.acMax ??= c.acMax
			}
		}
	for (const e of errors) console.error(e)
	return { online, readings, errors }
}

// ── Telegram ────────────────────────────────────────────────────
// Головні кнопки: стан + перехід у «папку» керування
const KEYBOARD = {
	inline_keyboard: [
		[{ text: '📊 Усі станції', callback_data: 'status' }],
		DEVICES.map((d) => ({ text: d.name, callback_data: d.cmd })),
		[
			{ text: '📈 Статистика', callback_data: 'stats' },
			{ text: '⚙️ Керування', callback_data: 'menu:control' },
		],
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

type SendOpts = { chatId?: string | number; loud?: boolean; keyboard?: boolean; silent?: boolean }

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
				disable_notification: o.silent || (!o.loud && isQuiet()),
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
	const { online, readings, errors } = await readAll(env, devices, devices.length === 1)
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
		if (OFFLINE_ALERT_MIN > 0 && !st.offlineAlerted && now - st.offlineSince >= OFFLINE_ALERT_MIN * 60000) {
			await telegram(env, `⚠️ <b>${esc(dev.name)} — немає зв'язку</b>\nВже ${duration(now - st.offlineSince)}. Сповіщення про заряд не працюють.`)
			st.offlineAlerted = true
		}
	} else {
		if (st.offlineAlerted && OFFLINE_ALERT_MIN > 0) await telegram(env, `✅ <b>${esc(dev.name)}</b> знову на зв'язку`)
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

// Повертає подію 'gridOn' / 'gridOff', якщо стан світла щойно змінився
async function checkGrid(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>): Promise<'gridOn' | 'gridOff' | null> {
	const src = readings.get(gridSn())
	if (!src || src.gridIn === null) return null // невідомо — нічого не міняємо
	const now = Date.now()
	const cur: GridState['state'] = src.gridIn ? 'ON' : 'OFF'
	const prev = await env.POWER_KV.get<GridState>('grid', 'json')
	if (prev?.state === cur) return null
	await env.POWER_KV.put('grid', JSON.stringify({ state: cur, since: now }))
	if (!prev) return null // перший запуск — просто запам'ятали
	const t = table(DEVICES, readings, online)
	if (cur === 'OFF') {
		// поточне відключення щойно почалось — рахуємо лише завершені сьогодні і додаємо його номером
		const day = await outagesIn(env, dayStart(now), now, false)
		const nth = day.count + 1
		const before = day.count ? ` · всього ${duration(day.ms)} без світла` : ''
		await telegram(
			env,
			`<b>🕯 Світло пішло</b>   <i>${clock(now)}</i>\n💡 Було ${duration(now - prev.since)}\n📈 Сьогодні: ${nth}-е відключення${before}${await prevOutageLine(env)}\n\n${t}`,
		)
		return 'gridOff'
	}
	await logOutage(env, prev.since, now)
	const day = await outagesIn(env, dayStart(now), now)
	await telegram(
		env,
		`<b>💡 Світло повернулось</b>   <i>${clock(now)}</i>\n🕯 Не було ${duration(now - prev.since)}\n📈 Сьогодні: ${fmtOut(day)}${await prevOutageLine(env, true)}\n\n${t}`,
	)
	return 'gridOn'
}

// ── Статистика відключень ───────────────────────────────────────
// Лог завершених відключень у KV (1 запис на подію), зберігаємо 35 днів
type Outage = { from: number; to: number }
async function logOutage(env: Env, from: number, to: number) {
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	log.push({ from, to })
	const keep = log.filter((o) => o.to > Date.now() - 35 * 86400_000)
	await env.POWER_KV.put('outlog', JSON.stringify(keep))
}

// Початок доби за Києвом (з урахуванням літнього/зимового часу)
const tzOffset = (t: number) => {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
			.formatToParts(new Date(t))
			.map((x) => [x.type, x.value]),
	)
	return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000
}
const dayStart = (t: number) => {
	const local = t + tzOffset(t)
	const d = new Date(local)
	const startLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
	return startLocal - tzOffset(startLocal - tzOffset(t))
}
const dateLabel = (t: number) => new Date(t).toLocaleDateString('uk-UA', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' })

// Скільки разів і скільки часу не було світла в інтервалі [a, b)
async function outagesIn(env: Env, a: number, b: number, includeCurrent = true) {
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const all = [...log]
	if (includeCurrent && grid?.state === 'OFF') all.push({ from: grid.since, to: Date.now() }) // поточне відключення
	let count = 0,
		ms = 0
	for (const o of all) {
		const x = Math.max(o.from, a),
			y = Math.min(o.to, b)
		if (y > x) {
			count++
			ms += y - x
		}
	}
	return { count, ms }
}

// «⏮ Попереднє: 2 год 5 хв (09:10–11:15)»; якщо не сьогодні — з датою
async function prevOutageLine(env: Env, skipLast = false) {
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	const o = log[log.length - 1 - (skipLast ? 1 : 0)]
	if (!o) return ''
	const sameDay = dayStart(o.from) === dayStart(Date.now())
	const when = `${sameDay ? '' : dateLabel(o.from) + ' '}${clock(o.from)}–${clock(o.to)}`
	return `\n⏮ Попереднє: ${duration(o.to - o.from)} (${when})`
}

const times = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'раз' : 'рази')
const fmtOut = (o: { count: number; ms: number }) => (o.count ? `${o.count} ${times(o.count)} · ${duration(o.ms)} без світла` : 'без відключень ✨')

async function statsText(env: Env) {
	const now = Date.now()
	const today = dayStart(now)
	const yest = dayStart(today - 1)
	const week = today - 7 * 86400_000
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const nowLine = grid ? (grid.state === 'ON' ? `💡 Зараз світло є ${duration(now - grid.since)}` : `🕯 Зараз світла немає ${duration(now - grid.since)}`) : ''
	return (
		`📈 <b>Відключення</b>   <i>${clock(now)}</i>\n\n` +
		`Сьогодні: ${fmtOut(await outagesIn(env, today, now))}\n` +
		`Вчора (${dateLabel(yest)}): ${fmtOut(await outagesIn(env, yest, today))}\n` +
		`За 7 днів: ${fmtOut(await outagesIn(env, week, today))}` +
		(nowLine ? `\n\n${nowLine}` : '')
	)
}

// Меню команд у Telegram будується з config.ts і оновлюється лише при змінах
async function syncCommands(env: Env) {
	const commands = [
		{ command: 'status', description: 'Усі станції: заряд і час роботи' },
		...DEVICES.map((d) => ({ command: d.cmd, description: d.name })),
		{ command: 'stats', description: 'Статистика відключень' },
		{ command: 'help', description: 'Список команд' },
	]
	const json = JSON.stringify(commands)
	if ((await env.POWER_KV.get('commands')) === json) return
	await tgCall(env, 'setMyCommands', { commands })
	await env.POWER_KV.put('commands', json)
}

// ── Автоматизації ───────────────────────────────────────────────
// Ціль дії: яке значення налаштування вона виставляє
const actionTarget = (a: Action) => {
	const f = a.kind === 'mqtt' ? new Map(a.fields) : null
	return {
		maxChg: a.kind === 'rest' ? a.params.cfgMaxChgSoc : f?.get(33),
		acMax: a.kind === 'rest' ? a.params.cfgPlugInInfoAcInChgPowMax : f?.get(54),
	}
}
// Знаходимо в ACTIONS дію потрібного типу станції, що виставляє саме це значення
const findAction = (d: Device, set: { maxChg?: number; acMax?: number }) =>
	Object.entries(ACTIONS).find(([, a]) => {
		if (a.for !== d.via) return false
		const t = actionTarget(a)
		return (set.maxChg === undefined || t.maxChg === set.maxChg) && (set.acMax === undefined || t.acMax === set.acMax) && (t.maxChg !== undefined) === (set.maxChg !== undefined)
	})
const AUTO_RETRY_MS = 30 * 60_000 // якщо станція не підтвердила — повтор не частіше ніж раз на 30 хв

async function runAutomations(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>, event: 'gridOn' | 'gridOff' | null) {
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	for (const [i, rule] of AUTOMATIONS.entries()) {
		if (rule.on && rule.on !== event) continue
		if (rule.grid && grid?.state !== rule.grid) continue
		if (rule.gridOnForH && !(grid?.state === 'ON' && Date.now() - grid.since >= rule.gridOnForH * 3600_000)) continue
		const targets = rule.cmd === '*' ? DEVICES : DEVICES.filter((x) => x.cmd === rule.cmd)
		for (const d of targets) {
			const r = readings.get(d.sn)
			if (!online.get(d.sn) || !r) continue
			if (rule.socAtLeast !== undefined && r.soc < rule.socAtLeast) continue
			if (rule.socAtMost !== undefined && r.soc > rule.socAtMost) continue
			const found = findAction(d, rule.set)
			if (!found) continue
			const [actionId, action] = found

			// уже стоїть потрібне значення — нічого не робимо
			const cur = await getSettings(d.sn)
			const now = { maxChg: r.maxChg ?? cur?.maxChg, acMax: r.acMax ?? cur?.acMax }
			const done = (rule.set.maxChg === undefined || now.maxChg === rule.set.maxChg) && (rule.set.acMax === undefined || now.acMax === rule.set.acMax)
			if (done) continue

			const retryKey = `auto:${i}:${d.cmd}`
			if (!rule.on) {
				const last = Number(await env.POWER_KV.get(retryKey))
				if (last && Date.now() - last < AUTO_RETRY_MS) continue
			}
			const confirmed = await runAction(env, d, action).catch((e) => {
				console.error('auto', d.name, actionId, e)
				return false
			})
			const what = `${action.group.replace(/^\S+\s/, '').toLowerCase()} ${action.label}`
			const why = rule.note ? ` <i>(${esc(rule.note)})</i>` : ''
			if (confirmed) {
				await saveSettings(d.sn, rule.set, true)
				await telegram(env, `🤖 <b>${esc(d.name)} ${r.soc}%</b> → ${what}${why}`, { silent: true })
			} else {
				if (!rule.on) await env.POWER_KV.put(retryKey, String(Date.now()), { expirationTtl: 3600 })
				await telegram(env, `🤖 ${esc(d.name)} → ${what}${why}: станція не підтвердила${rule.on ? '' : ', повторю за 30 хв'}`, { silent: true })
			}
		}
	}
}

async function run(env: Env) {
	await syncCommands(env).catch((e) => console.error('commands', e))
	const { online, readings } = await readAll(env, DEVICES, false, true)
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
	const event = await checkGrid(env, readings, online)
	await runAutomations(env, readings, online, event).catch((e) => console.error('automations', e))
}

// ── Telegram webhook: команди і кнопки ──────────────────────────
async function helpText() {
	const list = DEVICES.map((d) => `/${d.cmd} — ${esc(d.name)}`).join('\n')
	return `<b>🤖 Команди</b>\n/status — усі станції\n${list}\n/stats — статистика відключень\n\nАбо кнопки нижче.`
}

async function render(env: Env, cmd: string): Promise<Panel | null> {
	if (cmd === 'help' || cmd === 'start') return { text: await helpText() }
	if (cmd === 'stats') return { text: await statsText(env) }
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
				const confirmed = await runAction(env, d, action)
				const f = action.kind === 'mqtt' ? new Map(action.fields) : null
				const maxChg = action.kind === 'rest' ? action.params.cfgMaxChgSoc : f?.get(33)
				const acMax = action.kind === 'rest' ? action.params.cfgPlugInInfoAcInChgPowMax : f?.get(54)
				if (confirmed) await saveSettings(d.sn, { maxChg, acMax }, true)
				const what = `${d.name}: ${action.group.replace(/^\S+\s/, '').toLowerCase()} ${action.label}`
				note = confirmed ? `✅ ${what}` : `📤 ${what} — надіслано, станція не підтвердила. Перевір у застосунку`
			} catch (e) {
				console.error('set', e)
				note = `⚠️ Не вдалося: ${String(e).replace(/^Error:\s*/, '').slice(0, 150)}`
			}
			// якщо нове значення вже видно — пауза не потрібна; інакше даємо станції 2 с (вкладаємось у ~30 с ліміту Cloudflare)
			if (!note.startsWith('✅')) await new Promise((r) => setTimeout(r, 2000))
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
		initDevices(env)
		settingsEnv = env
		settingsCache.clear()
		ctx.waitUntil(run(env))
	},
	async fetch(req, env, ctx) {
		initDevices(env)
		settingsEnv = env
		settingsCache.clear()
		const url = new URL(req.url)
		if (url.pathname === '/telegram' && req.method === 'POST') {
			if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 })
			ctx.waitUntil(handleUpdate(env, await req.json()))
			return new Response('ok')
		}
		return new Response('ok')
	},
} satisfies ExportedHandler<Env>
