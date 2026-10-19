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

import { API, DEVICES, GRID_SOURCE, MQTT_WAIT_MS, OFFLINE_ALERT_MIN, QUIET_FROM, QUIET_TO, RESET_GAP, THRESHOLDS, TIMEZONE, type Device } from './config'

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
		// вхід відомий лише з 254/21; інакше — якщо батарея не розряджається, живимось від мережі
		const gridIn = p.inSumW !== undefined ? p.inSumW > 1 : !discharging
		result.set(sn, {
			soc: Math.round(p.soc),
			remMin: discharging && p.remMin !== undefined ? p.remMin : null,
			loadW: p.outSumW !== undefined ? Math.round(p.outSumW) : discharging ? (p.battOutW ?? null) : null,
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
const KEYBOARD = {
	inline_keyboard: [[{ text: '📊 Усі станції', callback_data: 'status' }], DEVICES.map((d) => ({ text: d.name, callback_data: d.cmd }))],
}

async function tgCall(env: Env, method: string, body: object) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`)
}

const kyivHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
const isQuiet = () => {
	const h = kyivHour()
	return QUIET_FROM < QUIET_TO ? h >= QUIET_FROM && h < QUIET_TO : h >= QUIET_FROM || h < QUIET_TO
}

type SendOpts = { chatId?: string | number; loud?: boolean; keyboard?: boolean }

// HTML-повідомлення; уночі — без звуку (якщо не loud); кнопки лише на панелі стану
// Явний роздільник у кінці кожного повідомлення, щоб сусідні не зливались
const DIVIDER = '━━━━━━━━━━━━━━━━━━'

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


type Panel = { text: string }

// Стан станції одним рядком: «⏳ 04:01 · ⚡ 58 Вт» / «🔌 від мережі»
const stateLine = (r: Reading) => {
	const load = r.loadW !== null ? ` · ⚡ ${r.loadW} Вт` : ''
	return r.remMin !== null ? `⏳ ${hhmm(r.remMin)}${load}` : r.gridIn ? `🔌 від мережі${load}` : `⏳ —${load}`
}

// Список усіх станцій в одній цитаті, по рядку на станцію
const table = (devices: Device[], readings: Map<string, Reading>, online: Map<string, boolean>) => {
	const lines = devices.map((d) => {
		const name = `<b>${esc(d.name)}</b>`
		const r = readings.get(d.sn)
		if (!online.get(d.sn)) return `⚫️ ${name} — офлайн`
		if (!r) return `❔ ${name} — немає даних`
		return `${socIcon(r.soc)} ${name}  <b>${r.soc}%</b> · ${stateLine(r)}`
	})
	return `<blockquote>${lines.join('\n')}</blockquote>`
}

// Рядок про світло — простим текстом під блоком
const gridText = (g: GridState | null, now: number) =>
	!g ? '' : g.state === 'ON' ? `💡 Світло є з ${clock(g.since)}` : `🕯 Без світла ${duration(now - g.since)} · з ${clock(g.since)}`

// Детальна картка однієї станції: головне — в блоці, жирним; світло — текстом знизу
const card = (d: Device, r: Reading | undefined, isOnline: boolean, g: GridState | null, now: number) => {
	const head = `<b>${esc(d.name)}</b>   <i>${clock(now)}</i>`
	const foot = gridText(g, now)
	if (!isOnline) return `⚫️ ${head}\n<blockquote>Офлайн</blockquote>${foot ? `\n${foot}` : ''}`
	if (!r) return `❔ ${head}\n<blockquote>Немає даних</blockquote>${foot ? `\n${foot}` : ''}`
	const time =
		r.remMin !== null ? `⏳ Залишилось  <b>${hhmm(r.remMin)}</b>` : r.gridIn ? `🔌 <b>Від мережі</b>` : `⏳ Залишилось  <b>—</b>`
	const load = r.loadW !== null ? `\n⚡ Споживання  <b>${r.loadW} Вт</b>` : ''
	return `${socIcon(r.soc)} ${head}\n<blockquote><code>${bar(r.soc)}</code>  <b>${r.soc}%</b>\n${time}${load}</blockquote>${foot ? `\n${foot}` : ''}`
}

async function statusPanel(env: Env, devices: Device[] = DEVICES): Promise<Panel> {
	const { online, readings } = await readAll(env, devices)
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	if (devices.length === 1) {
		const d = devices[0]
		return { text: card(d, readings.get(d.sn), online.get(d.sn)!, grid, now) }
	}
	const foot = gridText(grid, now)
	return { text: `📊 <b>Станції</b>   <i>${clock(now)}</i>\n${table(devices, readings, online)}${foot ? `\n${foot}` : ''}` }
}

const sendPanel = (env: Env, chatId: string | number, p: Panel) => telegram(env, p.text, { chatId, keyboard: true })

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
			await telegram(env, `⚠️ <b>${esc(dev.name)} — немає зв'язку</b>\n<blockquote>Вже ${duration(now - st.offlineSince)}. Сповіщення про заряд не працюють.</blockquote>`)
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
				await telegram(env, `${socIcon(t)} <b>${esc(dev.name)} — ${r.soc}%</b>${custom}\n<blockquote><code>${bar(r.soc)}</code>\n${rem}${load}</blockquote>`, { loud })
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
	if (cur === 'OFF') await telegram(env, `<b>🕯 Світло пішло</b>   <i>${clock(now)}</i>\n${t}`)
	else await telegram(env, `<b>💡 Світло повернулось</b> · не було ${duration(now - prev.since)}   <i>${clock(now)}</i>\n${t}`)
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
		await telegram(env, `📡 <b>Моніторинг EcoFlow запущено</b>\nПороги ${THRESHOLDS.join(' · ')}% · тиша ${QUIET_FROM}:00–${QUIET_TO}:00\n${table(DEVICES, readings, online)}`, { keyboard: true })
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
	return `<b>🤖 Команди</b>\n<blockquote>/status — усі станції\n${list}</blockquote>\nАбо кнопки нижче.`
}

async function render(env: Env, cmd: string): Promise<Panel | null> {
	if (cmd === 'help' || cmd === 'start') return { text: await helpText() }
	const devices = cmd === 'status' ? DEVICES : DEVICES.filter((d) => d.cmd === cmd)
	if (!devices.length) return null
	try {
		return await statusPanel(env, devices)
	} catch (e) {
		console.error('status', e)
		return { text: `⚠️ <b>Не вдалося отримати дані</b>\n<blockquote>${esc(String(e))}</blockquote>` }
	}
}

async function handleUpdate(env: Env, update: any) {
	const cb = update?.callback_query
	if (cb) {
		const chatId = cb.message?.chat?.id
		const ours = isOurChat(env, chatId)
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: ours ? 'Оновлюю…' : undefined }).catch(() => {})
		if (!ours) return
		const panel = await render(env, String(cb.data))
		if (!panel) return
		// Нове повідомлення з кнопками; старе лишається в історії, з нього прибираємо лише кнопки
		await tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
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
