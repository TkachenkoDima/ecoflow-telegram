// EcoFlow → Telegram: пороги розряду, світло, офлайн і команда /status.
// Маринка — офіційний IoT Open API; UPS (River 3) — MQTT застосунку EcoFlow.
// Cron раз на хвилину, стан у KV (пишемо лише при змінах, щоб влізти у free-ліміт).
import { mqttCollect, MqttAuthError } from './mqtt'
import { parseEcoflowPacket, type UpsPart } from './protobuf'

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

// ── Налаштування ────────────────────────────────────────────────
type Device = { sn: string; name: string; via: 'rest' | 'mqtt'; cmd: string }
const DEVICES: Device[] = [
	{ sn: 'D3M1ZE1A9H990005', name: 'Маринка', via: 'rest', cmd: 'marinka' },
	{ sn: 'R655ZEBAXH170579', name: 'UPS Kate', via: 'mqtt', cmd: 'kate' },
	{ sn: 'R655ZEBAXH171200', name: 'UPS Router', via: 'mqtt', cmd: 'router' },
]
const GRID_SOURCE = 'R655ZEBAXH171200' // по якій станції визначаємо світло (роутер має постійне навантаження)
const THRESHOLDS = [50, 25, 10] // %
const RESET_GAP = 10 // поріг знову активний, коли заряд піднявся на 10% вище
const OFFLINE_ALERT_MIN = 30
const MQTT_WAIT_MS = 15_000 // UPS шлють BMS-пакет кожні ~10 с
const API = 'https://api-e.ecoflow.com'
// ────────────────────────────────────────────────────────────────

type Reading = { soc: number; remMin: number | null; loadW: number | null; gridIn: boolean | null }
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
	return { soc, loadW, gridIn: acIn > 0, remMin: loadW > 0 && acIn === 0 ? Number(q.cmsDsgRemTime) : null }
}

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
		let gridIn: boolean | null = null
		if (p.inSumW !== undefined) gridIn = p.inSumW > 1
		else if (discharging) gridIn = false
		else if ((p.battInW ?? 0) > 0) gridIn = true
		result.set(sn, {
			soc: Math.round(p.soc),
			remMin: discharging && p.remMin !== undefined ? p.remMin : null,
			loadW: p.outSumW !== undefined ? Math.round(p.outSumW) : (p.battOutW ?? null),
			gridIn,
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
			const r = await readMqtt(env, devices.filter((d) => d.via === 'mqtt' && online.get(d.sn)).map((d) => d.sn))
			for (const [sn, v] of r) readings.set(sn, v)
		} catch (e) {
			errors.push(`MQTT: ${e}`)
		}
	})()
	await Promise.all([...restJobs, mqttJob])
	for (const e of errors) console.error(e)
	return { online, readings }
}

// ── Telegram ────────────────────────────────────────────────────
async function telegram(env: Env, text: string, chatId: string | number = env.TELEGRAM_CHAT_ID) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text }),
	})
	if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`)
}

const hhmm = (minutes: number) => {
	const m = Math.max(0, Math.round(minutes))
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const duration = (ms: number) => {
	const m = Math.floor(ms / 60000)
	return `${Math.floor(m / 60)} год ${m % 60} хв`
}
const clock = (t: number) => new Date(t).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' })

const line = (d: Device, r: Reading | undefined, isOnline: boolean) => {
	if (!isOnline) return `⚫️ ${d.name}: офлайн`
	if (!r) return `❔ ${d.name}: немає даних`
	const icon = r.soc <= 10 ? '🚨' : r.soc <= 25 ? '🪫' : '🔋'
	const rem = r.remMin !== null ? `⏳ ${hhmm(r.remMin)}` : r.gridIn ? 'від мережі' : '⏳ —'
	const load = r.loadW !== null ? ` · ⚡ ${r.loadW} Вт` : ''
	return `${icon} ${d.name}: ${r.soc}% · ${rem}${load}`
}

async function statusText(env: Env, devices: Device[] = DEVICES) {
	const { online, readings } = await readAll(env, devices)
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const lines = devices.map((d) => line(d, readings.get(d.sn), online.get(d.sn)!))
	let g = ''
	if (grid) g = grid.state === 'ON' ? `\n💡 Світло є (з ${clock(grid.since)})` : `\n🕯 Світла немає ${duration(Date.now() - grid.since)} (з ${clock(grid.since)})`
	return `📊 Стан на ${clock(Date.now())}\n${lines.join('\n')}${g}`
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
			await telegram(env, `⚠️ ${dev.name}: немає зв'язку вже ${duration(now - st.offlineSince)}. Сповіщення про заряд не працюють.`)
			st.offlineAlerted = true
		}
	} else {
		if (st.offlineAlerted) await telegram(env, `✅ ${dev.name}: знову на зв'язку`)
		st.offlineSince = null
		st.offlineAlerted = false

		if (r) {
			const crossed = THRESHOLDS.filter((t) => r.soc <= t && !st.notified.includes(t))
			if (crossed.length) {
				const t = Math.min(...crossed)
				const icon = t <= 10 ? '🚨' : t <= 25 ? '🪫' : '🔋'
				const rem = r.remMin !== null ? `⏳ Залишилось ≈ ${hhmm(r.remMin)}` : r.gridIn ? '🔌 Від мережі' : '⏳ Час невідомий'
				const load = r.loadW !== null ? `\n⚡ Споживання: ${r.loadW} Вт` : ''
				await telegram(env, `${icon} ${dev.name}: ${r.soc}%\n${rem}${load}`)
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
	const lines = DEVICES.map((d) => line(d, readings.get(d.sn), online.get(d.sn)!))
	if (cur === 'OFF') await telegram(env, `🕯 Світло пішло\n${lines.join('\n')}`)
	else await telegram(env, `💡 Світло повернулось\n⏱ Не було: ${duration(now - prev.since)}\n${lines.join('\n')}`)
}

async function run(env: Env) {
	const { online, readings } = await readAll(env)
	if (!(await env.POWER_KV.get('started:v2'))) {
		const lines = DEVICES.map((d) => line(d, readings.get(d.sn), online.get(d.sn)!))
		await telegram(env, `📡 Моніторинг EcoFlow запущено\nПороги: ${THRESHOLDS.join(' / ')}%\n${lines.join('\n')}\n\nКоманда /status — поточний стан`)
		await env.POWER_KV.put('started:v2', String(Date.now()))
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

// ── Telegram webhook: /status ───────────────────────────────────
async function handleUpdate(env: Env, update: any) {
	const msg = update?.message
	const cmd = (msg?.text ?? '').match(/^\/(\w+)(@\w+)?(\s|$)/)?.[1]?.toLowerCase()
	if (!cmd) return
	if (String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return // лише наша група
	const devices = cmd === 'status' ? DEVICES : DEVICES.filter((d) => d.cmd === cmd)
	if (cmd === 'help' || cmd === 'start') {
		const list = DEVICES.map((d) => `/${d.cmd} — ${d.name}`).join('\n')
		await telegram(env, `Команди:\n/status — усі станції\n${list}`, msg.chat.id)
		return
	}
	if (!devices.length) return
	try {
		await telegram(env, await statusText(env, devices), msg.chat.id)
	} catch (e) {
		console.error('status', e)
		await telegram(env, `⚠️ Не вдалося отримати дані: ${e}`, msg.chat.id)
	}
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
