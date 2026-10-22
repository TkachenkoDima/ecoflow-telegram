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

import { API, AUTOMATIONS, DEVICES, PIN_TO_TOP, PUSH_TTL_MIN, GRID_SOURCE, MQTT_WAIT_MS, OFFLINE_ALERT_MIN, QUIET_FROM, QUIET_TO, RESET_GAP, THRESHOLDS, TIMEZONE, type Automation, type Device } from './config'

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

type Reading = { soc: number; remMin: number | null; loadW: number | null; gridIn: boolean | null; maxChg?: number; acMax?: number; minDsg?: number }
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
		(r.acMax !== undefined ? `\n🔌 Макс. вхід  <b>${r.acMax} Вт</b>` : '') +
		(r.minDsg !== undefined ? `\n🔻 Мін. розряд  <b>${r.minDsg}%</b>` : '')
	return `${socIcon(r.soc)} ${head}\n<code>${bar(r.soc)}</code>  <b>${r.soc}%</b>\n${time}${load}${lim}${foot}`
}

// Опис автоматики станції: які правила, коли спрацьовують, яке діє зараз
function autoRules(d: Device, r: Reading | undefined, g: GridState | null, manualSince?: number) {
	const rules = AUTOMATIONS.filter((x) => x.cmd === d.cmd || x.cmd === '*')
	if (!rules.length) return ''
	const range = (a?: number, b?: number) => `${a ?? 0}–${b ?? 100}%`
	// коротко: лише діапазон заряду → що виставляє; чинне зараз — жирним
	const when = (x: Automation) =>
		x.on ? (x.on === 'gridOn' ? 'світло з\'явилось' : 'світло зникло') : range(x.socAtLeast, x.socAtMost)
	const what = (x: Automation) =>
		[x.set.acMax !== undefined ? `вхід ${x.set.acMax >= 1000 ? x.set.acMax / 1000 + ' кВт' : x.set.acMax + ' Вт'}` : '', x.set.maxChg !== undefined ? `ліміт ${x.set.maxChg}%` : '']
			.filter(Boolean)
			.join(', ')
	const active = (x: Automation) =>
		!!r &&
		!x.on &&
		(x.socAtLeast === undefined || r.soc >= x.socAtLeast) &&
		(x.socAtMost === undefined || r.soc <= x.socAtMost) &&
		(!x.grid || g?.state === x.grid) &&
		(!x.gridOnForH || (g?.state === 'ON' && Date.now() - g.since >= x.gridOnForH * 3600_000))
	const lines = rules.map((x) => {
		const line = `${when(x)} → ${what(x)}`
		return !manualSince && active(x) ? `<b>${line}</b>` : line
	})
	const head = manualSince ? '✋ Ручне' : '🤖 Авто'
	return `${head}
${lines.join('\n')}`
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
		return { text: card(d, readings.get(d.sn), online.get(d.sn)!, grid, now) + manualLine + errs, device: d }
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
		reply_markup: markup,
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
async function checkGrid(env: Env, readings: Map<string, Reading>, online: Map<string, boolean>): Promise<'gridOn' | 'gridOff' | null> {
	const src = readings.get(gridSn())
	if (!src || src.gridIn === null) return null // невідомо — нічого не міняємо
	const now = Date.now()
	const cur: GridState['state'] = src.gridIn ? 'ON' : 'OFF'
	const prev = await env.POWER_KV.get<GridState>('grid', 'json')
	if (prev?.state === cur) return null
	await env.POWER_KV.put('grid', JSON.stringify({ state: cur, since: now }))
	if (!prev) return null // перший запуск — просто запам'ятали
	// кожній групі — таблиця лише її станції (або всіх, якщо станцію не закріплено)
	const send = async (head: string) => {
		for (const chatId of chatIds(env)) {
			const st = await groupStation(env, chatId)
			const devs = st ? DEVICES.filter((d) => d.cmd === st) : DEVICES
			await telegram(env, `${head}\n\n${table(devs, readings, online)}`, { chatId, replaceKey: 'last:grid' }).catch((e) => console.error('grid push', chatId, e))
		}
	}
	if (cur === 'OFF') {
		// поточне відключення щойно почалось — рахуємо лише завершені сьогодні і додаємо його номером
		const day = await outagesIn(env, dayStart(now), now, false)
		const nth = day.count + 1
		const before = day.ms ? ` · всього ${duration(day.ms)} без світла` : '' // включно з нічним хвостом з учора
		await send(
			`<b>🕯 Світло пішло</b>   <i>${clock(now)}</i>\n💡 Було ${duration(now - prev.since)}\n📈 Сьогодні: ${nth}-е відключення${before}${await prevOutageLine(env)}`,
		)
		return 'gridOff'
	}
	await logOutage(env, prev.since, now)
	const day = await outagesIn(env, dayStart(now), now)
	await send(
		`<b>💡 Світло повернулось</b>   <i>${clock(now)}</i>\n🕯 Не було ${duration(now - prev.since)}\n📈 Сьогодні: ${fmtOut(day)}${await prevOutageLine(env, true)}`,
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
	// count — відключення, що ПОЧАЛИСЬ у [a, b) (кожне рахується рівно один раз, у день початку);
	// ms — фактичний час без світла в [a, b), включно з «хвостом» відключення, що почалось раніше (carryMs)
	let count = 0,
		ms = 0,
		carryMs = 0
	for (const o of all) {
		const x = Math.max(o.from, a),
			y = Math.min(o.to, b)
		if (y <= x) continue
		ms += y - x
		if (o.from >= a) count++
		else carryMs += y - x
	}
	return { count, ms, carryMs }
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

const times = (n: number) =>
	n % 10 === 1 && n % 100 !== 11 ? 'раз' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'рази' : 'разів'
const fmtOut = (o: { count: number; ms: number; carryMs: number }) => {
	if (!o.ms) return 'без відключень ✨'
	const carry = o.carryMs ? ` (${o.count ? 'з них ' + duration(o.carryMs) + ' — ' : ''}нічне зі вчора)` : ''
	return `${o.count} ${times(o.count)} · ${duration(o.ms)} без світла${carry}`
}

async function statsText(env: Env) {
	const now = Date.now()
	const today = dayStart(now)
	const yest = dayStart(today - 1)
	const week = dayStart(today - 6 * 86400_000 + 3600_000) // 7 днів, включно з сьогодні
	const grid = await env.POWER_KV.get<GridState>('grid', 'json')
	const nowLine = grid ? (grid.state === 'ON' ? `💡 Зараз світло є ${duration(now - grid.since)}` : `🕯 Зараз світла немає ${duration(now - grid.since)}`) : ''
	return (
		`📈 <b>Відключення</b>   <i>${clock(now)}</i>\n\n` +
		`Сьогодні: ${fmtOut(await outagesIn(env, today, now))}\n` +
		`Вчора (${dateLabel(yest)}): ${fmtOut(await outagesIn(env, yest, today))}\n` +
		`За 7 днів: ${fmtOut(await outagesIn(env, week, now))}` +
		(nowLine ? `\n\n${nowLine}` : '')
	)
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
type View = { body?: string; dev?: string; note?: string; label?: string; menu?: string; at: number }
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
		const rules = inControl ? autoRules(d, readings.get(d.sn), g, (await getManual(settingsEnv, d.sn))?.since) : ''
		return card(d, readings.get(d.sn), online.get(d.sn)!, g, now) + (rules ? `\n\n${rules}` : '')
	}
	if (shown) {
		await mergeSettings(readings.get(shown.sn), shown.sn)
		content = (v?.note ? `${esc(v.note)}\n\n` : '') + (await withAuto(shown))
	} else if (v?.body) content = v.body
	else {
		await mergeSettings(readings.get(groupDev.sn), groupDev.sn)
		content = await withAuto(groupDev)
	}
	// підпис «оновлюється щохвилини» — лише на «живих» картках
	const footer = v?.body && !shown ? '' : `\n\n<i>Оновлюється щохвилини · ${clock(now)}</i>`
	// окремий верхній рядок-статус прибрано: картка й так починається з назви і %
	return `${content}${footer}`
}

async function editPinned(env: Env, chatId: string | number, pin: Pin, text: string, markup: object) {
	await tgCall(env, 'editMessageText', { chat_id: chatId, message_id: pin.messageId, text, parse_mode: 'HTML', reply_markup: markup }).catch(async (e) => {
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
		await editPinned(env, chatId, pin, await screenText(line1, d, v, readings, online, g, now), menuMarkup(v?.menu))
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
		: { ...(prev ?? { at: Date.now() }), menu: upd.menu ?? prev?.menu }
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
		text: await screenText(pinFirstLine(d, r, online.get(d.sn)!, g, now), d, null, readings, online, g, now),
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
				panel.text = `${esc(note)}\n\n${panel.text}`
				await sendPanel(env, chatId, panel)
			}
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
	if (pin) return showInPinned(env, msg.chat.id, pin, DEVICES.some((x) => x.cmd === cmd) ? { dev: cmd } : { body: panel.text, label: labelFor(cmd) })
	await sendPanel(env, msg.chat.id, panel)
}

// ── Кнопки під закріпленим: результат — у ньому ж, без нових повідомлень ──
const labelFor = (data: string) =>
	data === 'status' ? 'Усі станції' : data === 'stats' ? 'Статистика' : data === 'help' ? 'Команди' : (DEVICES.find((d) => d.cmd === data)?.name ?? data)

async function pinnedCallback(env: Env, cb: any, chatId: number | string, pin: Pin, data: string) {
	const answer = (text?: string) => tgCall(env, 'answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {})
	// Миттєвий відгук: одразу міняємо кнопки (і показуємо «завантажую», якщо буде інший вміст), дані — слідом
	const instant = (markup: object, loading?: string) =>
		loading
			? tgCall(env, 'editMessageText', { chat_id: chatId, message_id: pin.messageId, text: `⏳ ${esc(loading)} — завантажую…`, parse_mode: 'HTML', reply_markup: markup }).catch(() => {})
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
		await answer(d ? `🤖 ${d.name}: автоматизації знову працюють` : '')
		return d ? showInPinned(env, chatId, pin, { dev: d.cmd, note: `🤖 ${d.name}: автоматика знову керує`, menu: 'main' }) : undefined
	}
	if (data.startsWith('set:')) {
		const [, cmd, actionId] = data.split(':')
		const d = DEVICES.find((x) => x.cmd === cmd)
		const action = ACTIONS[actionId]
		if (!d || !action || action.for !== d.via) return answer()
		await answer()
		await instant(deviceKeyboard(d), `${d.name}: надсилаю «${action.label}»`)
		const note = await applyAction(env, d, action)
		if (!note.startsWith('✅')) await new Promise((r) => setTimeout(r, 2000))
		return showInPinned(env, chatId, pin, { dev: d.cmd, note, menu: `dev:${d.cmd}` })
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
async function applyAction(env: Env, d: Device, action: Action): Promise<string> {
	try {
		const confirmed = await runAction(env, d, action)
		const f = action.kind === 'mqtt' ? new Map(action.fields) : null
		const maxChg = action.kind === 'rest' ? action.params.cfgMaxChgSoc : f?.get(33)
		const acMax = action.kind === 'rest' ? action.params.cfgPlugInInfoAcInChgPowMax : f?.get(54)
		const minDsg = action.kind === 'rest' ? action.params.cfgMinDsgSoc : f?.get(34)
		if (confirmed) await saveSettings(d.sn, { maxChg, acMax, minDsg }, true)
		if (AUTOMATIONS.some((r) => r.cmd === d.cmd || r.cmd === '*')) await setManual(env, d.sn) // ручне — пріоритетніше
		const what = `${d.name}: ${action.group.replace(/^\S+\s/, '').toLowerCase()} ${action.label}`
		return confirmed ? `✅ ${what}` : `📤 ${what} — надіслано, станція не підтвердила. Перевір у застосунку`
	} catch (e) {
		console.error('set', e)
		return `⚠️ Не вдалося: ${String(e).replace(/^Error:\s*/, '').slice(0, 150)}`
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
