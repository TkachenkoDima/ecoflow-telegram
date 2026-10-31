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

import { API, AUTOMATIONS, DEVICES, PIN_TO_TOP, PUSH_TTL_MIN, SCREEN_WIDTH, GRID_SOURCES, GRID_MIN_SOC, GRID_CONFIRM_MIN, MQTT_WAIT_MS, OFFLINE_ALERT_MIN, QUIET_FROM, QUIET_TO, RESET_GAP, THRESHOLDS, TIMEZONE, type Automation, type Device } from './config'

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

// grid — «свідчення» станції про світло: ON — є струм на вході, OFF — входу немає і батарея розряджається, null — не знає
type Reading = { soc: number; remMin: number | null; loadW: number | null; gridIn: boolean | null; grid?: 'ON' | 'OFF' | null; maxChg?: number; acMax?: number; minDsg?: number }
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
	const minDsg = Number(q.cmsMinDsgSoc)
	return {
		soc,
		loadW,
		gridIn: acIn > 0,
		grid: acIn > 5 ? 'ON' : acIn === 0 && loadW > 5 ? 'OFF' : null,
		remMin: loadW > 0 && acIn === 0 ? Number(q.cmsDsgRemTime) : null,
		maxChg: Number.isFinite(maxChg) ? maxChg : undefined,
		minDsg: Number.isFinite(minDsg) ? minDsg : undefined,
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
	max90: { label: '90%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 90 } },
	max100: { label: '100%', group: '🔝 Ліміт заряду', for: 'rest', kind: 'rest', params: { cfgMaxChgSoc: 100 } },
	min5: { label: '5%', group: '🔻 Мін. розряд', for: 'rest', kind: 'rest', params: { cfgMinDsgSoc: 5 } },
	min10: { label: '10%', group: '🔻 Мін. розряд', for: 'rest', kind: 'rest', params: { cfgMinDsgSoc: 10 } },
	ac500: { label: '500 Вт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 500], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	ac1000: { label: '1 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 1000], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	ac2000: { label: '2 кВт', group: '🔌 Вхідна потужність', for: 'rest', kind: 'mqtt', fields: [[54, 2000], [125, 0]] }, // API ігнорує; 125=0 — «застосувати»
	// River 3 (MQTT; макс. вхід від мережі ~305 Вт)
	rmax80: { label: '80%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', fields: [[33, 80]] },
	rmax90: { label: '90%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', fields: [[33, 90]] },
	rmax100: { label: '100%', group: '🔝 Ліміт заряду', for: 'mqtt', kind: 'mqtt', fields: [[33, 100]] },
	rmin5: { label: '5%', group: '🔻 Мін. розряд', for: 'mqtt', kind: 'mqtt', fields: [[34, 5]] },
	rmin10: { label: '10%', group: '🔻 Мін. розряд', for: 'mqtt', kind: 'mqtt', fields: [[34, 10]] },
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
type Settings = { maxChg?: number; acMax?: number; minDsg?: number; at: number; cmdAt?: number } // cmdAt — коли змінено командою бота
const RECENT_CMD_MS = 10 * 60_000
const SETTINGS_FRESH_MS = 60 * 60_000
let settingsEnv: Env // KV доступний лише через env — запам'ятовуємо на час запиту
const settingsCache = new Map<string, Settings | null>() // у межах одного запуску, щоб не читати KV двічі
async function getSettings(sn: string): Promise<Settings | null> {
	if (!settingsCache.has(sn)) settingsCache.set(sn, await settingsEnv.POWER_KV.get<Settings>(`settings:${sn}`, 'json'))
	return settingsCache.get(sn)!
}
async function saveSettings(sn: string, upd: { maxChg?: number; acMax?: number; minDsg?: number }, byCommand = false) {
	if (upd.maxChg === undefined && upd.acMax === undefined && upd.minDsg === undefined) return
	const prev = await getSettings(sn)
	const next: Settings = {
		maxChg: upd.maxChg ?? prev?.maxChg,
		acMax: upd.acMax ?? prev?.acMax,
		minDsg: upd.minDsg ?? prev?.minDsg,
		at: Date.now(),
		cmdAt: byCommand ? Date.now() : prev?.cmdAt,
	}
	const changed = !prev || prev.maxChg !== next.maxChg || prev.acMax !== next.acMax || prev.minDsg !== next.minDsg
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
	await Promise.all([...parts].map(([sn, p]) => saveSettings(sn, { maxChg: restOnly.includes(sn) ? undefined : p.maxChg, acMax: p.acMax, minDsg: restOnly.includes(sn) ? undefined : p.minDsg })))
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
			// впевнено — лише коли вхід відомий: є струм → ON; нуль і батарея віддає → OFF
			grid: p.inSumW === undefined ? null : p.inSumW > 5 ? 'ON' : p.inSumW <= 1 && discharging ? 'OFF' : null,
			maxChg: p.maxChg,
			acMax: p.acMax,
			minDsg: p.minDsg,
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
			if (recent && c?.minDsg !== undefined) rd.minDsg = c.minDsg
			if (!recent) await saveSettings(d.sn, { maxChg: rd.maxChg, minDsg: rd.minDsg })
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
				rd.minDsg ??= c.minDsg
			}
		}
	for (const e of errors) console.error(e)
	return { online, readings, errors }
}

// ── Знімок даних (кеш) ──────────────────────────────────────────
// Cron щохвилини читає всі станції — зберігаємо результат, і натискання кнопок малюють екран
// миттєво з нього, без MQTT (3–10 с). Наживо читаємо лише якщо знімок старший за SNAP_FRESH_MS.
// Три рівні: пам'ять воркера → Cache API дата-центру (безкоштовно, без лімітів) → KV (раз на 10 хв, ~144 записи/добу)
type Snap = { at: number; online: Record<string, boolean>; devs: Record<string, { r: Reading; at: number }> }
const SNAP_FRESH_MS = 3 * 60_000
const SNAP_KV_EVERY_MS = 10 * 60_000
const SNAP_URL = 'https://snap.internal/v1'
let memSnap: Snap | null = null

async function loadSnap(env: Env): Promise<Snap | null> {
	// пам'ять воркера — якщо зовсім свіжа; інакше беремо новіший з кешу дата-центру (його оновлює cron)
	if (memSnap && Date.now() - memSnap.at < 60_000) return memSnap
	const newer = (x: Snap | null) => {
		if (x && (!memSnap || x.at > memSnap.at)) memSnap = x
	}
	try {
		const hit = await caches.default.match(SNAP_URL)
		if (hit) newer(await hit.json<Snap>())
	} catch {}
	if (!memSnap || Date.now() - memSnap.at > SNAP_FRESH_MS) {
		const kv = await env.POWER_KV.get<Snap>('snap', 'json')
		if (kv && (!memSnap || kv.at > memSnap.at)) {
			newer(kv)
			await putSnapCache(kv)
		}
	}
	return memSnap
}
async function putSnapCache(s: Snap) {
	try {
		await caches.default.put(SNAP_URL, new Response(JSON.stringify(s), { headers: { 'Cache-Control': 'max-age=86400' } }))
	} catch {}
}
async function saveSnap(env: Env, online: Map<string, boolean>, readings: Map<string, Reading>, fromCron = false) {
	const prev = await loadSnap(env)
	const now = Date.now()
	const s: Snap = { at: now, online: Object.fromEntries(online), devs: { ...(prev?.devs ?? {}) } }
	for (const [sn, r] of readings) s.devs[sn] = { r: JSON.parse(JSON.stringify(r)), at: now }
	for (const [sn, on] of online) if (!on) delete s.devs[sn] // офлайн — старі цифри не показуємо
	memSnap = s
	await putSnapCache(s)
	if (fromCron) {
		const last = Number((await env.POWER_KV.get('snap:at')) ?? 0)
		if (now - last >= SNAP_KV_EVERY_MS) {
			await env.POWER_KV.put('snap', JSON.stringify(s))
			await env.POWER_KV.put('snap:at', String(now), { expirationTtl: 86400 })
		}
	}
}

// Дані для екрана: зі знімка, якщо свіжий; інакше — наживо (і оновлюємо знімок)
async function readCached(env: Env, devices: Device[], detailed: boolean) {
	const snap = await loadSnap(env)
	const now = Date.now()
	const fresh =
		snap &&
		now - snap.at < SNAP_FRESH_MS &&
		devices.every((d) => (snap.online[d.sn] ? !!snap.devs[d.sn] && now - snap.devs[d.sn].at < SNAP_FRESH_MS : snap.online[d.sn] === false))
	if (!fresh) {
		const res = await readAll(env, devices, detailed)
		await saveSnap(env, res.online, res.readings).catch(() => {})
		return res
	}
	const online = new Map(DEVICES.map((d) => [d.sn, !!snap.online[d.sn]]))
	const readings = new Map<string, Reading>()
	for (const d of devices) {
		const e = snap.devs[d.sn]
		if (!e) continue
		const r: Reading = JSON.parse(JSON.stringify(e.r))
		// щойно змінене кнопкою — показуємо нове значення, а не зі знімка
		const c = await getSettings(d.sn)
		if (c?.cmdAt !== undefined && now - c.cmdAt < RECENT_CMD_MS) {
			if (c.maxChg !== undefined) r.maxChg = c.maxChg
			if (c.acMax !== undefined) r.acMax = c.acMax
			if (c.minDsg !== undefined) r.minDsg = c.minDsg
		}
		readings.set(d.sn, r)
	}
	return { online, readings, errors: [] as string[] }
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
// ── Ручний режим: автоматизації не чіпають станцію ──
// Безстроково — доки не натиснуть «🤖 Авто»
type Manual = { since: number }
const manualKey = (sn: string) => `manual:${sn}`
const getManual = (env: Env, sn: string) => env.POWER_KV.get<Manual>(manualKey(sn), 'json')
const setManual = (env: Env, sn: string) => env.POWER_KV.put(manualKey(sn), JSON.stringify({ since: Date.now() }))
const clearManual = (env: Env, sn: string) => env.POWER_KV.delete(manualKey(sn))

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
			...(AUTOMATIONS.some((r) => r.cmd === d.cmd || r.cmd === '*') ? [[{ text: '🤖 Авто (скасувати ручне)', callback_data: `auto:${d.cmd}` }]] : []),
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

type SendOpts = { chatId?: string | number; loud?: boolean; keyboard?: boolean; silent?: boolean; forDevice?: string; replaceKey?: string }

// HTML-повідомлення; уночі — без звуку (якщо не loud); кнопки лише на панелі стану
// Явний роздільник у кінці кожного повідомлення, щоб сусідні не зливались
// U+2800 (порожній символ Брайля) Telegram не обрізає — дає «повітря» внизу бульбашки
const DIVIDER = '\u2800'

// TELEGRAM_CHAT_ID може містити кілька груп через кому: "-555…,-401…"
const chatIds = (env: Env) => env.TELEGRAM_CHAT_ID.split(',').map((x) => x.trim()).filter(Boolean)
const isOurChat = (env: Env, id: unknown) => chatIds(env).includes(String(id))

// Відповідь у конкретний чат (o.chatId) або розсилка в усі групи; збій однієї групи не блокує інші
// ── Самовидалення пушів ──
// Черга в KV на групу: [{id, at}] — коли видалити. Cron щохвилини прибирає прострочені.
type Expiring = { id: number; at: number }
const ttlKey = (chatId: string | number) => `ttl:${chatId}`
const deleteAtFor = (now: number) => {
	if (!isQuiet()) return now + PUSH_TTL_MIN * 60_000
	// тихий режим: до ранку (QUIET_TO) + PUSH_TTL_MIN
	let morning = dayStart(now) + QUIET_TO * 3600_000
	if (morning <= now) morning += 86400_000
	return morning + PUSH_TTL_MIN * 60_000
}
async function scheduleDelete(env: Env, chatId: string | number, messageId: number) {
	const list = (await env.POWER_KV.get<Expiring[]>(ttlKey(chatId), 'json')) ?? []
	list.push({ id: messageId, at: deleteAtFor(Date.now()) })
	await env.POWER_KV.put(ttlKey(chatId), JSON.stringify(list))
}
async function cleanupExpired(env: Env) {
	for (const chatId of chatIds(env)) {
		const list = await env.POWER_KV.get<Expiring[]>(ttlKey(chatId), 'json')
		if (!list?.length) continue
		const now = Date.now()
		const due = list.filter((x) => x.at <= now)
		if (!due.length) continue
		for (const x of due) await tgCall(env, 'deleteMessage', { chat_id: chatId, message_id: x.id }).catch(() => {})
		const rest = list.filter((x) => x.at > now)
		if (rest.length) await env.POWER_KV.put(ttlKey(chatId), JSON.stringify(rest))
		else await env.POWER_KV.delete(ttlKey(chatId))
	}
}

// «Станція групи» — та, що закріплена через /pin; без /pin група отримує все
const groupStation = async (env: Env, chatId: string | number) => (await env.POWER_KV.get<{ cmd: string }>(`pin:${chatId}`, 'json'))?.cmd

async function telegram(env: Env, text: string, o: SendOpts = {}) {
	let targets: (string | number)[] = o.chatId !== undefined ? [o.chatId] : chatIds(env)
	if (o.chatId === undefined && o.forDevice) {
		const st = await Promise.all(targets.map((id) => groupStation(env, id)))
		targets = targets.filter((_, i) => !st[i] || st[i] === o.forDevice)
		if (!targets.length) return
	}
	const results = await Promise.allSettled(
		targets.map(async (chat_id) => {
			const msg = await tgCall(env, 'sendMessage', {
				chat_id,
				text: `${text}\n${DIVIDER}`,
				parse_mode: 'HTML',
				link_preview_options: { is_disabled: true },
				disable_notification: o.silent || (!o.loud && isQuiet()),
				...(o.keyboard ? { reply_markup: KEYBOARD } : {}),
			})
			if (msg?.message_id) await scheduleDelete(env, chat_id, msg.message_id)
			// схема «лише останнє»: прибираємо попередній пуш цього ж типу
			if (o.replaceKey && msg?.message_id) {
				const key = `${o.replaceKey}:${chat_id}`
				const prev = Number(await env.POWER_KV.get(key))
				if (prev) await tgCall(env, 'deleteMessage', { chat_id, message_id: prev }).catch(() => {})
				await env.POWER_KV.put(key, String(msg.message_id))
			}
		}),
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
	if (m >= 1440) {
		// від доби — дні, години й хвилини: 1 день, 2 дні, 5 днів, 21 день
		const dd = Math.floor(m / 1440)
		const h = Math.floor((m % 1440) / 60)
		const word = dd % 10 === 1 && dd % 100 !== 11 ? 'день' : [2, 3, 4].includes(dd % 10) && ![12, 13, 14].includes(dd % 100) ? 'дні' : 'днів'
		return [`${dd} ${word}`, h ? `${h} год` : '', m % 60 ? `${m % 60} хв` : ''].filter(Boolean).join(', ')
	}
	return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год${m % 60 ? ` ${m % 60} хв` : ''}`
}
const clock = (t: number, sec = false) =>
	new Date(t).toLocaleTimeString('uk-UA', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) })
const socIcon = (soc: number) => (soc <= 10 ? '🚨' : soc <= 25 ? '🪫' : '🔋')
const bar = (soc: number) => {
	const n = Math.max(0, Math.min(10, Math.round(soc / 10)))
	return '▰'.repeat(n) + '▱'.repeat(10 - n)
}


type Panel = { text: string; device?: Device; markup?: object }

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
			const load = r.loadW !== null ? ` · ⚡ ${r.loadW} Вт` : ''
			const st = r.remMin !== null ? `⏳ ${hhmm(r.remMin)}` : r.gridIn ? '🔌 від мережі' : '⏳ —'
			return `${socIcon(r.soc)} ${name}  <b>${r.soc}%</b>${load}\n<code>${bar(r.soc)}</code>  ${st}`
		})
		.join('\n\n')

// Рядок про світло — простим текстом під блоком
// Сьогодні: «💡 Світло є 01:16 · з 14:47»; якщо почалось в інший день — з датою, двома рядками:
// «💡 Світло є 3 дні, 2 год, 15 хв» / «усього 74 год 15 хв» / «з 23.10, 13:38»
const gridText = (g: GridState | null, now: number) => {
	if (!g) return ''
	const head = g.state === 'ON' ? '💡 Світло є' : '🕯 Без світла'
	if (dayStart(g.since) === dayStart(now)) return `${head} ${hhmm((now - g.since) / 60_000)} · з ${clock(g.since)}`
	// + загальна кількість годин: «усього 75 год 27 хв»
	const tm = Math.floor((now - g.since) / 60_000)
	const total = tm >= 1440 ? `\nусього ${Math.floor(tm / 60)} год${tm % 60 ? ` ${tm % 60} хв` : ''}` : '' // до доби — дублювало б
	return `${head} ${duration(now - g.since)}${total}\nз ${dateLabel(g.since)}, ${clock(g.since)}`
}

// Детальна картка однієї станції: усе звичайним текстом, світло — окремим рядком знизу
// mode — іконка замість 🔌 у «Макс. вхід»: хто ним зараз керує (🤖 авто / ✋ ручне)
const card = (d: Device, r: Reading | undefined, isOnline: boolean, g: GridState | null, now: number, mode = '') => {
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
		(r.acMax !== undefined ? `\n${mode || '🔌'} Макс. вхід  <b>${r.acMax} Вт</b>` : '') +
		(r.minDsg !== undefined ? `\n🔻 Мін. розряд  <b>${r.minDsg}%</b>` : '')
	return `${socIcon(r.soc)} ${head}\n<code>${bar(r.soc)}</code>  <b>${r.soc}%</b>\n${time}${load}${lim}${foot}`
}

// Чи діє правило зараз (за зарядом і світлом); правила «on: подія» — лише в момент події
const ruleActive = (x: Automation, r: Reading | undefined, g: GridState | null) =>
	!!r &&
	!x.on &&
	(x.socAtLeast === undefined || r.soc >= x.socAtLeast) &&
	(x.socAtMost === undefined || r.soc <= x.socAtMost) &&
	(!x.grid || g?.state === x.grid) &&
	(!x.gridOnForH || (g?.state === 'ON' && Date.now() - g.since >= x.gridOnForH * 3600_000))
const ruleWhat = (x: Automation) =>
	[x.set.acMax !== undefined ? `вхід ${x.set.acMax >= 1000 ? x.set.acMax / 1000 + ' кВт' : x.set.acMax + ' Вт'}` : '', x.set.maxChg !== undefined ? `ліміт ${x.set.maxChg}%` : '']
		.filter(Boolean)
		.join(', ')

// Опис автоматики станції: які правила, коли спрацьовують, яке діє зараз
function autoRules(d: Device, r: Reading | undefined, g: GridState | null, manualSince?: number) {
	const rules = AUTOMATIONS.filter((x) => x.cmd === d.cmd || x.cmd === '*')
	// у ручному режимі правила не працюють — не показуємо їх (режим видно по ✋ у «Макс. вхід»)
	if (!rules.length || manualSince) return ''
	const range = (a?: number, b?: number) => `${a ?? 0}–${b ?? 100}%`
	// коротко: лише діапазон заряду → що виставляє; чинне зараз — жирним
	const when = (x: Automation) =>
		x.on ? (x.on === 'gridOn' ? 'світло з\'явилось' : 'світло зникло') : range(x.socAtLeast, x.socAtMost)
	const what = ruleWhat
	const active = (x: Automation) => ruleActive(x, r, g)
	const lines = rules.map((x) => {
		const line = `${when(x)} → ${what(x)}`
		return !manualSince && active(x) ? `<b>${line}</b>` : line
	})
	const head = manualSince ? '✋ Ручне' : '🤖 Авто'
	// ліміт заряду нижче порогу правила — до нього заряд не дійде
	const cap = r?.maxChg
	const dead = cap !== undefined ? rules.filter((x) => x.set.acMax !== undefined && (x.socAtLeast ?? 0) >= cap) : []
	// короткими рядками, щоб не розширювати екран
	const deadRanges = dead.map((x) => range(x.socAtLeast, x.socAtMost))
	// у ручному режимі правила й так не працюють — підказка лише заплутує
	const capNote = dead.length && !manualSince
		? `\n\n<i>⚠️ Ліміт заряду ${cap}%\nвище заряд не піде,\n${dead.length === 1 ? `правило ${deadRanges[0]} не діє` : `не діють правила:\n${deadRanges.join(', ')}`}</i>`
		: ''
	return `${head}
${lines.join('\n')}${capNote}`
}

async function statusPanel(env: Env, devices: Device[] = DEVICES): Promise<Panel> {
	const { online, readings, errors } = await readCached(env, devices, devices.length === 1)
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	// якщо дані не прийшли — показуємо причину, а не просто «немає даних»
	const errs = errors.length ? `\n\n<i>⚠️ ${esc(errors.join('; ').slice(0, 300))}</i>` : ''
	if (devices.length === 1) {
		const d = devices[0]
		const m = await getManual(env, d.sn)
		const rules = autoRules(d, readings.get(d.sn), grid, m?.since)
		const manualLine = rules ? `\n\n${rules}` : ''
		const mode = AUTOMATIONS.some((x) => x.cmd === d.cmd || x.cmd === '*') ? (m ? '✋' : '🤖') : ''
		return { text: card(d, readings.get(d.sn), online.get(d.sn)!, grid, now, mode) + manualLine + errs, device: d }
	}
	const g_ = gridText(grid, now)
	const foot = g_ ? `\n\n${g_}` : ''
	return { text: `📊 <b>Станції</b>   <i>${clock(now)}</i>\n\n${table(devices, readings, online)}${foot}${errs}` }
}

// ── Кнопки лише під останньою панеллю ──
// id останньої панелі в кожному чаті тримаємо в Cache API (безкоштовно, не витрачає ліміт записів KV)
// id останньої панелі (відповідь на кнопку/команду) у KV — щоб видалити її, коли прийде нова
const panelKey = (chatId: string | number) => `panel:${chatId}`
const noKeyboard = (env: Env, chatId: string | number, messageId: number) =>
	tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
// видалити повідомлення бота; якщо не вийшло (старше 48 год або немає прав) — хоча б прибрати кнопки
const removeMsg = (env: Env, chatId: string | number, messageId: number) =>
	tgCall(env, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => noKeyboard(env, chatId, messageId))

async function sendPanel(env: Env, chatId: string | number, p: Panel, markup: object = KEYBOARD) {
	const prev = Number(await env.POWER_KV.get(panelKey(chatId)))
	const msg = await tgCall(env, 'sendMessage', {
		chat_id: chatId,
		text: `${p.text}\n${DIVIDER}`,
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: true },
		disable_notification: true, // відповідь на дію — без звуку
		reply_markup: p.markup ?? markup,
	})
	if (prev && prev !== msg?.message_id && !(await isPinnedMsg(env, chatId, prev))) await removeMsg(env, chatId, prev)
	if (msg?.message_id) await env.POWER_KV.put(panelKey(chatId), String(msg.message_id))
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
				await telegram(env, `${socIcon(t)} <b>${esc(dev.name)} — ${r.soc}%</b>${custom}\n<code>${bar(r.soc)}</code>\n${rem}${load}`, { loud, forDevice: dev.cmd, replaceKey: `last:thr:${dev.cmd}` })
				st.notified.push(...crossed)
			}
			st.notified = st.notified.filter((t) => r.soc < t + RESET_GAP)
		}
	}
	if (JSON.stringify(st) !== before) await env.POWER_KV.put(kvKey, JSON.stringify(st))
}

// Повертає подію 'gridOn' / 'gridOff', якщо стан світла щойно змінився
// Рішення про світло: перша станція з GRID_SOURCES, яка «знає» (онлайн, заряд > GRID_MIN_SOC, впевнене свідчення)
function gridDecision(readings: Map<string, Reading>, online: Map<string, boolean>): GridState['state'] | null {
	for (const src of GRID_SOURCES) {
		const d = DEVICES.find((x) => x.cmd === src.cmd)
		const r = d ? readings.get(d.sn) : undefined
		if (!d || !online.get(d.sn) || !r || r.soc <= GRID_MIN_SOC || !r.grid) continue
		if (src.onlyOn && r.grid !== 'ON') continue
		return r.grid
	}
	return null
}
// «Очікує підтвердження» — у Cache API + пам'яті воркера (без записів у KV, навіть якщо щось «скаче»)
type PendingGrid = { state: GridState['state']; since: number }
const PENDING_URL = 'https://grid-pending.internal/v1'
let memPending: PendingGrid | null = null
async function getPendingGrid(): Promise<PendingGrid | null> {
	try {
		const hit = await caches.default.match(PENDING_URL)
		if (hit) return await hit.json<PendingGrid>()
	} catch {}
	return memPending
}
async function setPendingGrid(p: PendingGrid | null) {
	if (!p && !memPending) {
		try {
			if (!(await caches.default.match(PENDING_URL))) return
		} catch {}
	}
	memPending = p
	try {
		if (p) await caches.default.put(PENDING_URL, new Response(JSON.stringify(p), { headers: { 'Cache-Control': 'max-age=3600' } }))
		else await caches.default.delete(PENDING_URL)
	} catch {}
}

async function checkGrid(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>): Promise<'gridOn' | 'gridOff' | null> {
	const cur = gridDecision(readings, online)
	if (!cur) return null // жодна станція не знає — нічого не міняємо
	const now = Date.now()
	const prev = await env.POWER_KV.get<GridState>('grid', 'json')
	if (prev?.state === cur) {
		await setPendingGrid(null)
		return null
	}
	// підтвердження: новий стан має протриматись GRID_CONFIRM_MIN хв (очікування — у безкоштовному кеші, не в KV)
	const pending = await getPendingGrid()
	if (prev && (!pending || pending.state !== cur)) {
		await setPendingGrid({ state: cur, since: now })
		return null
	}
	if (prev && pending && now - pending.since < (GRID_CONFIRM_MIN - 1) * 60_000 + 30_000) return null
	const since = pending?.state === cur ? pending.since : now // з моменту, коли вперше побачили
	await setPendingGrid(null)
	await env.POWER_KV.put('grid', JSON.stringify({ state: cur, since }))
	if (!prev) return null // перший запуск — просто запам'ятали
	// кожній групі — таблиця лише її станції (або всіх, якщо станцію не закріплено)
	const send = async (head: string) => {
		for (const chatId of chatIds(env)) {
			const st = await groupStation(env, chatId)
			const devs = st ? DEVICES.filter((d) => d.cmd === st) : DEVICES
			await telegram(env, `${head}\n\n${table(devs, readings, online)}`, { chatId, replaceKey: 'last:grid' }).catch((e) => console.error('grid push', chatId, e))
		}
	}
	// підсумок за сьогодні — як у «📈 Статистика» (без «найчастіше»: за один день воно нічого не каже)
	const today = async () => {
		const S = await statsData(env)
		const lines = S.summary(dayStart(now), now).filter((l) => !l.startsWith('🕐'))
		return `\n\n📈 <b>Сьогодні</b>\n${lines.join('\n')}`
	}
	if (cur === 'OFF') {
		await send(`<b>🕯 Світло пішло</b>   <i>${clock(now)}</i>\n💡 Було ${duration(now - prev.since)}${await today()}${await prevOutageLine(env)}`)
		return 'gridOff'
	}
	await logOutage(env, prev.since, now)
	await send(`<b>💡 Світло повернулось</b>   <i>${clock(now)}</i>\n🕯 Не було ${duration(now - prev.since)}${await today()}`)
	return 'gridOn'
}

// ── Статистика відключень ───────────────────────────────────────
// Лог завершених відключень у KV (1 запис на подію), зберігаємо ~рік (≈40 байт на подію)
type Outage = { from: number; to: number }
async function logOutage(env: Env, from: number, to: number) {
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	log.push({ from, to })
	const keep = log.filter((o) => o.to > Date.now() - 400 * 86400_000)
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

// «⏮ Попереднє: 2 год 5 хв (09:10–11:15)»; якщо не сьогодні — з датою
async function prevOutageLine(env: Env, skipLast = false) {
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	const o = log[log.length - 1 - (skipLast ? 1 : 0)]
	if (!o) return ''
	const sameDay = dayStart(o.from) === dayStart(Date.now())
	const when = `${sameDay ? '' : dateLabel(o.from) + ' '}${clock(o.from)}–${clock(o.to)}`
	return `\n⏮ Попереднє: ${duration(o.to - o.from)} (${when})`
}

const times = (n: number) =>
	n % 10 === 1 && n % 100 !== 11 ? 'раз' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'рази' : 'разів'

// ── Розділ «📈 Статистика»: тиждень / місяць / календар / день ──
// callback_data: st:w:<зсув> тиждень · st:m:<зсув> місяць · st:c:<зсув> календар місяця · st:d:<рік>-<міс>-<день> день
// Зсув — 0 поточний, -1 попередній… «Назад»: день → календар → місяць → головна; тиждень/місяць → головна
const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень']
const WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
// місцева (Київ) дата → мітка часу початку цього дня; Date.UTC сам переносить «32 жовтня» → 1 листопада
const localDay = (y: number, m: number, d: number) => {
	const g = Date.UTC(y, m, d)
	return g - tzOffset(g - tzOffset(g))
}
const ymd = (t: number) => {
	const d = new Date(t + tzOffset(t))
	return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() }
}
const weekStart = (off: number, now: number) => {
	const n = ymd(now)
	return localDay(n.y, n.m, n.d - ((n.wd + 6) % 7) + 7 * off)
}
const monthStart = (off: number, now: number) => {
	const n = ymd(now)
	return localDay(n.y, n.m + off, 1)
}
const monthOffsetOf = (t: number, now: number) => {
	const a = ymd(t),
		b = ymd(now)
	return (a.y - b.y) * 12 + (a.m - b.m)
}
const hm = (ms: number) => {
	const m = Math.round(ms / 60_000)
	return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}
const pad2 = (n: number) => String(n).padStart(2, '0')
// смужка частки часу без світла: 8 клітинок = 100%
const offBar = (ms: number, span: number) => {
	const c = ms ? Math.min(8, Math.max(1, Math.round((ms / span) * 8))) : 0
	return `<code>${'▰'.repeat(c)}${'▱'.repeat(8 - c)}</code>`
}

async function statsData(env: Env) {
	const now = Date.now()
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const log = (await env.POWER_KV.get<Outage[]>('outlog', 'json')) ?? []
	const all: Outage[] = [...log, ...(grid?.state === 'OFF' ? [{ from: grid.since, to: now }] : [])]
	// з якого моменту бот веде лог — раніше даних немає (а не «без відключень»)
	const started = Number((await env.POWER_KV.get('started:v3')) ?? now)
	const trackFrom = Math.min(started, all[0]?.from ?? now, grid?.since ?? now)
	const inRange = (a: number, b: number) => {
		let count = 0,
			ms = 0
		for (const o of all) {
			const x = Math.max(o.from, a),
				y = Math.min(o.to, b)
			if (y <= x) continue
			ms += y - x
			if (o.from >= a) count++
		}
		return { count, ms }
	}
	// підсумок періоду: разом, частка зі світлом, найдовше, середнє, найчастіші години
	const summary = (a: number, b: number) => {
		const end = Math.min(b, now)
		const o = inRange(a, end)
		const span = end - Math.max(a, trackFrom)
		if (span <= 0) return ['<i>немає даних</i>']
		if (!o.ms) return ['Без відключень ✨']
		// кожен показник — окремим рядком
		const lines = [
			...(o.count ? [`🔢 Відключень: ${o.count}`] : []),
			`🕯 Без світла: ${duration(o.ms)}${o.count ? '' : ' (з учора)'}`,
			`🔆 Зі світлом: ${Math.max(0, Math.round(100 - (o.ms / span) * 100))}% часу`,
		]
		const started = all.filter((x) => x.from >= a && x.from < end)
		const longest = [...started].sort((x, y) => y.to - y.from - (x.to - x.from))[0]
		if (longest && started.length > 1) {
			const cur = grid?.state === 'OFF' && longest.from === grid.since
			lines.push(`⏱ Найдовше: ${duration(longest.to - longest.from)}${end - a > 86400_000 + 3600_000 ? ` · ${dateLabel(longest.from)}` : ''}${cur ? ' (триває)' : ''}`)
		}
		const done = started.filter((x) => !(grid?.state === 'OFF' && x.from === grid.since))
		if (done.length >= 2) lines.push(`➗ Середнє: ${duration(done.reduce((s, x) => s + x.to - x.from, 0) / done.length)}`)
		if (done.length >= 3) {
			// хвилини без світла за годинами доби → найгірше 3-годинне вікно
			const byHour = new Array(24).fill(0)
			for (const x of all) {
				const f = Math.max(x.from, a),
					t2 = Math.min(x.to, end)
				if (t2 <= f) continue
				const off = tzOffset(f)
				for (let t = f; t < t2; t += 5 * 60_000) byHour[new Date(t + off).getUTCHours()] += 5
			}
			const win = (h: number) => byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24]
			let best = 0
			for (let h = 1; h < 24; h++) if (win(h) > win(best)) best = h
			lines.push(`🕐 Найчастіше: ${pad2(best)}:00–${pad2((best + 3) % 24)}:00`)
		}
		return lines
	}
	return { now, grid, all, trackFrom, inRange, summary }
}

const NAV_BOTTOM = (back: string) => [
	{ text: '⬅️ Назад', callback_data: back },
	{ text: '🏠 Головна', callback_data: 'menu:main' },
]
const btn = (text: string, data: string) => ({ text, callback_data: data })
const blank = () => btn(DIVIDER, 'noop')

async function statsView(env: Env, data: string): Promise<{ text: string; markup: object }> {
	const S = await statsData(env)
	const { now, trackFrom } = S
	// «📈 Статистика» за замовчуванням відкриває сьогоднішній день
	const t0 = ymd(now)
	const [, kind, arg = '0'] = data === 'stats' ? ['st', 't', `${t0.y}-${t0.m + 1}-${t0.d}`] : data.split(':')
	// той самий рядок про світло, що й у картці станції (з «усього» і датою, якщо почалось не сьогодні)
	const nowLine = gridText(S.grid, now)
	const dayRow = (a: number, b: number, label: string) => {
		const end = Math.min(b, now)
		if (end <= trackFrom) return `${label}  —`
		const o = S.inRange(a, end)
		return `${label}  ${offBar(o.ms, end - a)}  ${o.ms ? (o.count ? o.count + ' · ' : '') + hm(o.ms) : '✨'}`
	}
	const today = ymd(now)
	const todayArg = `${today.y}-${today.m + 1}-${today.d}`
	const modeRow = (k: 'd' | 'w' | 'm') => [
		btn(k === 'd' ? '✓ День' : 'День', `st:t:${todayArg}`),
		btn(k === 'w' ? '✓ Тиждень' : 'Тиждень', 'st:w:0'),
		btn(k === 'm' ? '✓ Місяць' : 'Місяць', 'st:m:0'),
	]
	// недоступні стрілки не показуємо (без порожніх кнопок)
	const arrowRow = (label: string, prevData: string | null, nextData: string | null) => [
		...(prevData ? [btn('◀', prevData)] : []),
		btn(label, 'noop'),
		...(nextData ? [btn('▶', nextData)] : []),
	]
	const arrows = (k: string, off: number, label: string, canBack: boolean) =>
		arrowRow(label, canBack ? `st:${k}:${off - 1}` : null, off < 0 ? `st:${k}:${off + 1}` : null)

	if (kind === 'w' || kind === 'm') {
		const off = Math.min(0, Number(arg) || 0)
		const a = kind === 'w' ? weekStart(off, now) : monthStart(off, now)
		const b = kind === 'w' ? weekStart(off + 1, now) : monthStart(off + 1, now)
		const title = kind === 'w' ? `${dateLabel(a)}–${dateLabel(b - 1)}` : `${MONTHS[ymd(a).m]} ${ymd(a).y}`
		const rows: string[] = []
		if (kind === 'w') {
			for (let i = 0, t = a; i < 7 && t < now; i++) {
				const next = localDay(ymd(a).y, ymd(a).m, ymd(a).d + i + 1)
				rows.push(dayRow(t, next, `${WD[ymd(t).wd]} ${dateLabel(t)}`))
				t = next
			}
		} else {
			// по тижнях (пн–нд), обрізаних межами місяця
			let t = a
			while (t < b && t < now) {
				const p = ymd(t)
				const next = Math.min(b, localDay(p.y, p.m, p.d + 7 - ((p.wd + 6) % 7)))
				rows.push(dayRow(t, next, `${pad2(p.d)}–${pad2(ymd(next - 1).d)}`))
				t = next
			}
		}
		const cur = off === 0
		const text =
			`📈 <b>${kind === 'w' ? 'Тиждень' : 'Місяць'}</b> · ${title}\n\n${rows.join('\n')}\n\n${S.summary(a, b).join('\n')}` + (cur && nowLine ? `\n\n${nowLine}` : '')
		const markup = {
			inline_keyboard: [
				modeRow(kind),
				arrows(kind, off, title, a > trackFrom),
				[btn('📅 Календар', `st:c:${monthOffsetOf(a, now)}`)],
				NAV_BOTTOM('menu:main'),
			],
		}
		return { text, markup }
	}

	if (kind === 'c') {
		const off = Math.min(0, Number(arg) || 0)
		const a = monthStart(off, now)
		const b = monthStart(off + 1, now)
		const p = ymd(a)
		const days: Array<{ text: string; callback_data: string }> = []
		for (let i = 0; i < (p.wd + 6) % 7; i++) days.push(blank())
		for (let t = a, d = 1; t < b; d++, t = localDay(p.y, p.m, d)) {
			const next = localDay(p.y, p.m, d + 1)
			if (t > now || next <= trackFrom) days.push(btn(String(d), 'noop')) // майбутнє / до початку логу — без дії
			else {
				const o = S.inRange(t, Math.min(next, now))
				days.push(btn(o.ms ? `${d}•` : String(d), `st:d:${p.y}-${p.m + 1}-${d}`))
			}
		}
		while (days.length % 7) days.push(blank())
		const grid: object[][] = [['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((x) => btn(x, 'noop'))]
		for (let i = 0; i < days.length; i += 7) grid.push(days.slice(i, i + 7))
		const title = `${MONTHS[p.m]} ${p.y}`
		const text = `📅 <b>Календар</b> · ${title}\n\n<b>•</b> — були відключення\n\n${S.summary(a, b).slice(0, 3).join('\n')}`
		const markup = { inline_keyboard: [arrows('c', off, title, a > trackFrom), ...grid, NAV_BOTTOM(`st:m:${off}`)] }
		return { text, markup }
	}

	// день
	const [y, m, d] = arg.split('-').map(Number)
	const a = localDay(y, m - 1, d)
	const b = localDay(y, m - 1, d + 1)
	const end = Math.min(b, now)
	const list = S.all
		.filter((o) => o.to > a && o.from < end)
		.map((o) => {
			const ongoing = S.grid?.state === 'OFF' && o.from === S.grid.since
			const f = o.from < a ? `${clock(o.from)} ${dateLabel(o.from)}` : clock(o.from)
			const t = ongoing ? 'досі' : o.to > b ? `${clock(o.to)} ${dateLabel(o.to)}` : clock(o.to)
			return `${f}–${t} · ${duration(o.to - o.from)}`
		})
	// таймлайн доби: 24 клітинки по годині (▰ — без світла ≥ 30 хв цієї години)
	let line = ''
	for (let h = 0; h < 24; h++) {
		const ha = a + h * 3600_000,
			hb = ha + 3600_000
		line += ha >= now ? '·' : S.inRange(ha, Math.min(hb, now)).ms >= 30 * 60_000 ? '▰' : '▱'
	}
	const body =
		end <= trackFrom
			? '<i>немає даних</i>'
			: `<code>${line}</code>\n<code>0     6     12    18   </code>\n\n${list.length ? `${list.join('\n')}\n\n${S.summary(a, b).join('\n')}` : 'Без відключень ✨'}`
	const isToday = a === dayStart(now)
	const text = `📈 <b>День</b> · ${WD[ymd(a).wd]} ${dateLabel(a)}${isToday ? ' (сьогодні)' : ''}\n\n${body}` + (isToday && nowLine ? `\n\n${nowLine}` : '')
	const prev = ymd(a - 1),
		next = ymd(b)
	const top = kind === 't'
	const markup = {
		inline_keyboard: [
			...(top ? [modeRow('d')] : []),
			arrowRow(
				dateLabel(a),
				a > trackFrom ? `st:${kind}:${prev.y}-${prev.m + 1}-${prev.d}` : null,
				b < now ? `st:${kind}:${next.y}-${next.m + 1}-${next.d}` : null,
			),
			...(top ? [[btn('📅 Календар', `st:c:${monthOffsetOf(a, now)}`)]] : []),
			NAV_BOTTOM(top ? 'menu:main' : `st:c:${monthOffsetOf(a, now)}`),
		],
	}
	return { text, markup }
}

// Меню команд у Telegram будується з config.ts і оновлюється лише при змінах
async function syncCommands(env: Env) {
	const commands = [
		{ command: 'status', description: 'Усі станції: заряд і час роботи' },
		...DEVICES.map((d) => ({ command: d.cmd, description: d.name })),
		{ command: 'stats', description: 'Статистика відключень' },
		{ command: 'pin', description: 'Закріпити смужку стану: /pin marinka' },
		{ command: 'unpin', description: 'Прибрати закріплену смужку' },
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
	const manual = new Set<string>()
	for (const d of DEVICES) if (await getManual(env, d.sn)) manual.add(d.sn)
	for (const [i, rule] of AUTOMATIONS.entries()) {
		if (rule.on && rule.on !== event) continue
		if (rule.grid && grid?.state !== rule.grid) continue
		if (rule.gridOnForH && !(grid?.state === 'ON' && Date.now() - grid.since >= rule.gridOnForH * 3600_000)) continue
		const targets = rule.cmd === '*' ? DEVICES : DEVICES.filter((x) => x.cmd === rule.cmd)
		for (const d of targets) {
			const r = readings.get(d.sn)
			if (!online.get(d.sn) || !r) continue
			if (manual.has(d.sn)) continue // ручне керування має пріоритет
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
				console.log('auto', d.name, r.soc, what) // успіх — без повідомлення, видно в картці станції
			} else {
				if (!rule.on) await env.POWER_KV.put(retryKey, String(Date.now()), { expirationTtl: 3600 })
				await telegram(env, `🤖 ${esc(d.name)} → ${what}${why}: станція не підтвердила${rule.on ? '' : ', повторю за 30 хв'}`, { silent: true, forDevice: d.cmd, replaceKey: 'last:auto' })
			}
		}
	}
}

// ── Закріплена «смужка» стану станції в групі ──────────────────
// /pin <станція> — закріпити, /unpin — прибрати. Перший рядок повідомлення видно у смужці вгорі чату;
// cron щохвилини редагує його (лише якщо текст змінився — це перевіряє сам Telegram).
type Pin = { cmd: string; messageId: number }
const pinKey = (chatId: string | number) => `pin:${chatId}`
const isPinnedMsg = async (env: Env, chatId: string | number, messageId: number) =>
	(await env.POWER_KV.get<Pin>(pinKey(chatId), 'json'))?.messageId === messageId

// Стан «екрана» в закріпленому: що показано і яке меню кнопок. Живе VIEW_TTL_S, потім — картка станції групи
// body — статичний вміст (усі станції, статистика); dev — «жива» картка цієї станції (оновлюється щохвилини);
// note — рядок результату над карткою (напр. «✅ Router: ліміт 90%»)
type View = { body?: string; dev?: string; note?: string; label?: string; menu?: string; markup?: object; at: number }
const VIEW_TTL_S = 180
const viewKey = (chatId: string | number) => `view:${chatId}`
const getView = (env: Env, chatId: string | number) => env.POWER_KV.get<View>(viewKey(chatId), 'json')
const saveView = (env: Env, chatId: string | number, v: View) => env.POWER_KV.put(viewKey(chatId), JSON.stringify(v), { expirationTtl: VIEW_TTL_S })
const menuMarkup = (menu?: string) => {
	if (menu === 'control') return CONTROL_KEYBOARD
	const dev = menu?.startsWith('dev:') ? DEVICES.find((x) => x.cmd === menu.slice(4)) : undefined
	return dev ? deviceKeyboard(dev) : KEYBOARD
}

// Перший рядок — це смужка вгорі чату: завжди станція групи
const pinFirstLine = (d: Device, r: Reading | undefined, isOnline: boolean, g: GridState | null, now: number) => {
	let first: string
	if (!isOnline) first = `⚫️ ${d.name} офлайн`
	else if (!r) first = `❔ ${d.name} — немає даних`
	else first = `${socIcon(r.soc)} ${d.name} ${r.soc}%${r.remMin !== null ? ` · ⏳ ${hhmm(r.remMin)}` : ''}`
	const light = !g ? '' : g.state === 'ON' ? ' · 💡' : ` · 🕯 ${duration(now - g.since)}`
	return esc(first + light)
}

// Що показати під смужкою: відкритий перегляд (жива картка іншої станції / статичний вміст) або картку станції групи
const mergeSettings = async (r: Reading | undefined, sn: string) => {
	const c = r ? await getSettings(sn) : null
	if (r && c) {
		r.maxChg ??= c.maxChg
		r.acMax ??= c.acMax
		r.minDsg ??= c.minDsg
	}
}
async function screenText(line1: string, groupDev: Device, v: View | null, readings: Map<string, Reading>, online: Map<string, boolean>, g: GridState | null, now: number) {
	let content: string
	const shown = v?.dev ? DEVICES.find((x) => x.cmd === v.dev) : undefined
	// правила автоматики — лише в «Керування → станція», на головному екрані не потрібні
	const inControl = !!v?.menu?.startsWith('dev:')
	const withAuto = async (d: Device) => {
		const hasAuto = AUTOMATIONS.some((x) => x.cmd === d.cmd || x.cmd === '*')
		const manual = hasAuto ? await getManual(settingsEnv, d.sn) : null
		const rules = inControl ? autoRules(d, readings.get(d.sn), g, manual?.since) : ''
		// іконка режиму в «Макс. вхід» — скрізь; в «Керування» ще й повний блок правил
		const mode = hasAuto ? (manual ? '✋' : '🤖') : ''
		return card(d, readings.get(d.sn), online.get(d.sn)!, g, now, mode) + (rules ? `\n\n${rules}` : '')
	}
	if (shown) {
		await mergeSettings(readings.get(shown.sn), shown.sn)
		content = (v?.note ? `${v.note}\n\n` : '') + (await withAuto(shown))
	} else if (v?.body) content = v.body
	else {
		await mergeSettings(readings.get(groupDev.sn), groupDev.sn)
		content = await withAuto(groupDev)
	}
	// без верхнього рядка-статусу і без підпису «оновлюється щохвилини»: час оновлення — у заголовку картки
	return content
}

// Однакова ширина «екрана» на всіх переходах: Telegram Desktop підганяє бульбашку під найширший рядок
// (а якщо текст вужчий за кнопки — розтягує на всю ширину). Тому в кінець завжди йде невидимий рядок
// фіксованої ширини (SCREEN_WIDTH символів U+2800), а всі рядки екранів — коротші за нього. На телефоні непомітно
function padWidth(html: string) {
	return `${html}\n${DIVIDER.repeat(SCREEN_WIDTH)}`
}

async function editPinned(env: Env, chatId: string | number, pin: Pin, text: string, markup: object) {
	await tgCall(env, 'editMessageText', { chat_id: chatId, message_id: pin.messageId, text: padWidth(text), parse_mode: 'HTML', reply_markup: markup }).catch(async (e) => {
		const err = String(e)
		if (err.includes('message is not modified')) return
		console.error('pin', chatId, err)
		if (err.includes('message to edit not found')) await env.POWER_KV.delete(pinKey(chatId)) // повідомлення видалили
	})
}

// Cron: щохвилини оновлюємо смужку і (якщо нічого не відкрито) картку станції групи
async function updatePins(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>) {
	const g = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	for (const chatId of chatIds(env)) {
		const pin = await env.POWER_KV.get<Pin>(pinKey(chatId), 'json')
		if (!pin) continue
		const d = DEVICES.find((x) => x.cmd === pin.cmd)
		if (!d) continue
		const v = await getView(env, chatId)
		const line1 = pinFirstLine(d, readings.get(d.sn), online.get(d.sn)!, g, now)
		await editPinned(env, chatId, pin, await screenText(line1, d, v, readings, online, g, now), v?.markup ?? menuMarkup(v?.menu))
	}
}

// Натискання на екрані: показуємо результат прямо в ньому (нових повідомлень немає)
async function showInPinned(
	env: Env,
	chatId: string | number,
	pin: Pin,
	upd: { body?: string; dev?: string; note?: string; label?: string; menu?: string; home?: boolean },
) {
	const prev = upd.home ? null : await getView(env, chatId) // «Головна» — скидаємо все до станції групи
	const content = upd.body !== undefined || upd.dev !== undefined
	const v: View = content
		? { body: upd.body, dev: upd.dev, note: upd.note, label: upd.label, menu: upd.menu ?? prev?.menu, at: Date.now() }
		: { ...(prev ?? { at: Date.now() }), menu: upd.menu ?? prev?.menu, markup: undefined }
	const isDefault = !v.body && !v.dev && (!v.menu || v.menu === 'main')
	if (isDefault) await env.POWER_KV.delete(viewKey(chatId))
	else await saveView(env, chatId, v)

	const d = DEVICES.find((x) => x.cmd === pin.cmd)!
	const shown = v.dev ? DEVICES.find((x) => x.cmd === v.dev) : undefined
	const need = [d, ...(shown && shown !== d ? [shown] : [])]
	const { online, readings } = await readCached(env, need, true)
	const g = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	const line1 = pinFirstLine(d, readings.get(d.sn), online.get(d.sn)!, g, now)
	await editPinned(env, chatId, pin, await screenText(line1, d, isDefault ? null : v, readings, online, g, now), menuMarkup(v.menu))
}

// Розділ статистики в «екрані»: свій текст і свої кнопки (поки відкритий — cron їх не чіпає)
async function pinnedStats(env: Env, chatId: string | number, pin: Pin, data: string) {
	const { text, markup } = await statsView(env, data)
	await saveView(env, chatId, { body: text, markup, menu: 'stats', at: Date.now() })
	await editPinned(env, chatId, pin, text, markup)
}

async function pinCommand(env: Env, chatId: number | string, arg: string | undefined): Promise<string> {
	const old = await env.POWER_KV.get<Pin>(pinKey(chatId), 'json')
	if (old) {
		await tgCall(env, 'unpinChatMessage', { chat_id: chatId, message_id: old.messageId }).catch(() => {})
		await tgCall(env, 'deleteMessage', { chat_id: chatId, message_id: old.messageId }).catch(() => {}) // старий «екран» більше не потрібен
	}
	if (!arg) {
		await env.POWER_KV.delete(pinKey(chatId))
		return old ? '📌 Смужку прибрано' : '📌 Закріпленої смужки не було'
	}
	const d = DEVICES.find((x) => x.cmd === arg.toLowerCase())
	if (!d) return `Не знаю станцію «${esc(arg)}». Доступні: ${DEVICES.map((x) => x.cmd).join(', ')}`
	const { online, readings } = await readAll(env, [d], true)
	const g = await env.POWER_KV.get<GridState>('grid', 'json')
	const now = Date.now()
	const r = readings.get(d.sn)
	const msg = await tgCall(env, 'sendMessage', {
		chat_id: chatId,
		text: padWidth(await screenText(pinFirstLine(d, r, online.get(d.sn)!, g, now), d, null, readings, online, g, now)),
		parse_mode: 'HTML',
		disable_notification: true,
		reply_markup: KEYBOARD,
	})
	if (PIN_TO_TOP)
		try {
			await tgCall(env, 'pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true })
		} catch (e) {
			console.error('pinChatMessage', e)
			return '⚠️ Не можу закріпити: зробіть бота адміністратором групи з правом «Закріплювати повідомлення» і повторіть /pin'
		}
	await env.POWER_KV.put(pinKey(chatId), JSON.stringify({ cmd: d.cmd, messageId: msg.message_id }))
	return ''
}

async function run(env: Env) {
	await syncCommands(env).catch((e) => console.error('commands', e))
	const { online, readings } = await readAll(env, DEVICES, false, true)
	await saveSnap(env, online, readings, true).catch((e) => console.error('snap', e))
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
	await updatePins(env, readings, online).catch((e) => console.error('pins', e))
	await cleanupExpired(env).catch((e) => console.error('cleanup', e))
}

// ── Telegram webhook: команди і кнопки ──────────────────────────
async function helpText() {
	const list = DEVICES.map((d) => `/${d.cmd} — ${esc(d.name)}`).join('\n')
	return `<b>🤖 Команди</b>\n/status — усі станції\n${list}\n/stats — статистика відключень\n/pin &lt;станція&gt; — закріпити смужку стану (напр. /pin marinka)\n/unpin — прибрати смужку\n\nАбо кнопки нижче.`
}

async function render(env: Env, cmd: string): Promise<Panel | null> {
	if (cmd === 'help' || cmd === 'start') return { text: await helpText() }
	if (cmd === 'stats') {
		const v = await statsView(env, 'stats')
		return { text: v.text, markup: v.markup }
	}
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
		const pin = ours ? await env.POWER_KV.get<Pin>(pinKey(chatId), 'json') : null
		if (pin && pin.messageId === cb.message?.message_id) return pinnedCallback(env, cb, chatId, pin, data)
		// Навігація між «папками» — міняємо лише кнопки під тим самим повідомленням
		if (data === 'noop' || data.startsWith('menu:')) {
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {})
			if (!ours || data === 'noop') return
			const dev = data.startsWith('menu:dev:') ? DEVICES.find((x) => x.cmd === data.slice(9)) : undefined
			const markup = dev ? deviceKeyboard(dev) : data === 'menu:control' ? CONTROL_KEYBOARD : KEYBOARD
			// Закріплене повідомлення бот оновлює щохвилини — меню з нього відкриваємо окремим повідомленням
			if (await isPinnedMsg(env, chatId, cb.message.message_id)) {
				if (data === 'menu:main') return
				await sendPanel(env, chatId, { text: `⚙️ <b>Керування${dev ? ' · ' + esc(dev.name) : ''}</b>` }, markup).catch((e) => console.error('menu', e))
				return
			}
			await tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: markup }).catch(() => {})
			return
		}
		if (ours && data.startsWith('auto:')) {
			const d = DEVICES.find((x) => x.cmd === data.slice(5))
			if (d) await clearManual(env, d.sn)
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: d ? `🤖 ${d.name}: автоматизації знову працюють` : '' }).catch(() => {})
			// повертаємо головні кнопки — як «🏠 Головна»
			await tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: KEYBOARD }).catch(() => {})
			return
		}
		if (ours && data.startsWith('set:')) {
			const [, cmd, actionId] = data.split(':')
			const d = DEVICES.find((x) => x.cmd === cmd)
			const action = ACTIONS[actionId]
			if (!d || !action || action.for !== d.via) return
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Надсилаю команду…' }).catch(() => {})
			const note = await applyAction(env, d, action)
			// якщо нове значення вже видно — пауза не потрібна; інакше даємо станції 2 с (вкладаємось у ~30 с ліміту Cloudflare)
			if (!note.startsWith('✅')) await new Promise((r) => setTimeout(r, 2000))
			const panel = await render(env, d.cmd)
			if (panel) {
				panel.text = `${note}\n\n${panel.text}`
				await sendPanel(env, chatId, panel)
			}
			return
		}
		if (ours && data.startsWith('st:')) {
			await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {})
			const v = await statsView(env, data)
			await tgCall(env, 'editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `${v.text}\n${DIVIDER}`, parse_mode: 'HTML', reply_markup: v.markup }).catch(() => {})
			return
		}
		await tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: ours ? 'Оновлюю…' : undefined }).catch(() => {})
		if (!ours) return
		const panel = await render(env, data)
		if (!panel) return
		// Нове повідомлення з кнопками; старе лишається в історії, з нього прибираємо лише кнопки

		await sendPanel(env, chatId, panel)
		return
	}
	const msg = update?.message
	const m = (msg?.text ?? '').match(/^\/(\w+)(@\w+)?(?:\s+(\S+))?/)
	const cmd = m?.[1]?.toLowerCase()
	if (!cmd) return
	if (!isOurChat(env, msg.chat.id)) return // лише наші групи
	if (cmd === 'pin' || cmd === 'unpin') {
		await removeUserMsg(env, msg)
		if (cmd === 'pin' && !m?.[3]) {
			await sendPanel(env, msg.chat.id, { text: `📌 Вкажіть станцію: ${DEVICES.map((x) => `/pin ${x.cmd}`).join(' · ')}` })
			return
		}
		const reply = await pinCommand(env, msg.chat.id, cmd === 'pin' ? m?.[3] : undefined)
		if (reply) await sendPanel(env, msg.chat.id, { text: reply })
		return
	}
	const panel = await render(env, cmd)
	if (!panel) return
	await removeUserMsg(env, msg)
	const pin = await env.POWER_KV.get<Pin>(pinKey(msg.chat.id), 'json')
	if (pin && cmd === 'stats') return pinnedStats(env, msg.chat.id, pin, 'stats')
	if (pin) return showInPinned(env, msg.chat.id, pin, DEVICES.some((x) => x.cmd === cmd) ? { dev: cmd } : { body: panel.text, label: labelFor(cmd) })
	await sendPanel(env, msg.chat.id, panel)
}

// ── Кнопки під закріпленим: результат — у ньому ж, без нових повідомлень ──
const labelFor = (data: string) =>
	data === 'status' ? 'Усі станції' : data === 'stats' ? 'Статистика' : data === 'help' ? 'Команди' : (DEVICES.find((d) => d.cmd === data)?.name ?? data)

async function pinnedCallback(env: Env, cb: any, chatId: number | string, pin: Pin, data: string) {
	const answer = (text?: string) => tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {})
	// Миттєвий відгук: одразу міняємо кнопки (і показуємо «завантажую», якщо буде інший вміст), дані — слідом
	// два короткі рядки (що + дія), щоб не розширювати екран
	const instant = (markup: object, loading?: string, verb = 'завантажую') =>
		loading
			? tgCall(env, 'editMessageText', { chat_id: chatId, message_id: pin.messageId, text: padWidth(`⏳ ${esc(loading)}\n${verb}…`), parse_mode: 'HTML', reply_markup: markup }).catch(() => {})
			: tgCall(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: pin.messageId, reply_markup: markup }).catch(() => {})
	const nameOf = (cmd: string) => DEVICES.find((x) => x.cmd === cmd)?.name ?? cmd
	if (data === 'noop') return answer()
	if (data.startsWith('menu:')) {
		await answer()
		if (data === 'menu:main') {
			await instant(KEYBOARD)
			return showInPinned(env, chatId, pin, { home: true })
		}
		if (data === 'menu:control') {
			// вміст не змінюється — лише кнопки, без читання даних
			await instant(CONTROL_KEYBOARD)
			const prev = await getView(env, chatId)
			await saveView(env, chatId, { ...(prev ?? { at: Date.now() }), menu: 'control' })
			return
		}
		// Керування → станція: одразу її кнопки + «завантажую», потім «жива» картка
		const cmd = data.slice(9)
		const dev = DEVICES.find((x) => x.cmd === cmd)
		if (dev) await instant(deviceKeyboard(dev), nameOf(cmd))
		return showInPinned(env, chatId, pin, { dev: cmd, label: cmd, menu: `dev:${cmd}` })
	}
	if (data.startsWith('auto:')) {
		const d = DEVICES.find((x) => x.cmd === data.slice(5))
		if (d) await clearManual(env, d.sn)
		await answer()
		if (!d) return
		await instant(KEYBOARD, `${d.name}\nавто режим`, 'застосовую правило')
		// не чекаємо cron — застосовуємо чинне правило одразу
		const { readings, online } = await readCached(env, [d], false)
		const g = await env.POWER_KV.get<GridState>('grid', 'json')
		const rule = AUTOMATIONS.find((x) => (x.cmd === d.cmd || x.cmd === '*') && ruleActive(x, readings.get(d.sn), g))
		await runAutomations(env, readings, online, null).catch((e) => console.error('automations', e))
		const note = `✅ ${esc(d.name)}\n🤖 авто режим увімкнено\n${rule ? `${ruleWhat(rule).replace('вхід ', 'вхід → ')} (${rule.socAtLeast ?? 0}–${rule.socAtMost ?? 100}%)` : 'правила зараз не діють'}`
		return showInPinned(env, chatId, pin, { dev: d.cmd, note, menu: 'main' })
	}
	if (data.startsWith('set:')) {
		const [, cmd, actionId] = data.split(':')
		const d = DEVICES.find((x) => x.cmd === cmd)
		const action = ACTIONS[actionId]
		if (!d || !action || action.for !== d.via) return answer()
		await answer()
		await instant(deviceKeyboard(d), `${d.name}\n${shortGroup(action)} → ${action.label}`, 'надсилаю')
		const note = await applyAction(env, d, action)
		if (!note.startsWith('✅')) await new Promise((r) => setTimeout(r, 2000))
		return showInPinned(env, chatId, pin, { dev: d.cmd, note, menu: `dev:${d.cmd}` })
	}
	if (data === 'stats' || data.startsWith('st:')) {
		await answer()
		return pinnedStats(env, chatId, pin, data)
	}
	await answer()
	const prevMenu = (await getView(env, chatId))?.menu
	await instant(menuMarkup(prevMenu), labelFor(data))
	// кнопка станції — «жива» картка; інше (усі станції, статистика) — статичний знімок
	if (DEVICES.some((x) => x.cmd === data)) return showInPinned(env, chatId, pin, { dev: data })
	const panel = await render(env, data)
	if (panel) await showInPinned(env, chatId, pin, { body: panel.text, label: labelFor(data) })
}

// Ручна дія з «Керування»: виконати, запам'ятати, увімкнути ручний режим; повертає текст результату
// «🔌 Вхідна потужність» → «вхід»: коротка назва налаштування для повідомлень
const shortGroup = (a: Action) => a.group.replace(/^\S+\s/, '').toLowerCase().replace('вхідна потужність', 'вхід')

// Результат — коротко, кількома рядками (щоб не розширювати екран):
// ✅ Маринка / ліміт заряду → 80% / застосовано (+ ✋ автоматика на паузі, якщо дія її вимкнула)
async function applyAction(env: Env, d: Device, action: Action): Promise<string> {
	const what = `${esc(d.name)}\n${shortGroup(action)} → ${action.label}`
	try {
		const confirmed = await runAction(env, d, action)
		const f = action.kind === 'mqtt' ? new Map(action.fields) : null
		const maxChg = action.kind === 'rest' ? action.params.cfgMaxChgSoc : f?.get(33)
		const acMax = action.kind === 'rest' ? action.params.cfgPlugInInfoAcInChgPowMax : f?.get(54)
		const minDsg = action.kind === 'rest' ? action.params.cfgMinDsgSoc : f?.get(34)
		if (confirmed) await saveSettings(d.sn, { maxChg, acMax, minDsg }, true)
		// ручний режим — лише якщо дія чіпає те, чим керує автоматика (напр. вхід Вт);
		// ліміти заряду/розряду автоматику не ставлять на паузу
		const rules = AUTOMATIONS.filter((r) => r.cmd === d.cmd || r.cmd === '*')
		const conflicts = rules.some((r) => (acMax !== undefined && r.set.acMax !== undefined) || (maxChg !== undefined && r.set.maxChg !== undefined))
		if (conflicts) await setManual(env, d.sn)
		const pause = conflicts ? '\n✋ автоматика на паузі' : ''
		return confirmed ? `✅ ${what}\nзастосовано${pause}` : `📤 ${what}\nнадіслано, станція\nне підтвердила${pause}`
	} catch (e) {
		console.error('set', e)
		return `⚠️ ${what}\nне вдалося:\n${esc(String(e).replace(/^Error:\s*/, '').slice(0, 60))}`
	}
}

// Команду користувача прибираємо, щоб не засмічувати чат (потрібне право адміна «Видаляти повідомлення»)
const removeUserMsg = (env: Env, msg: any) => tgCall(env, 'deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {})

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
