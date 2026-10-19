// EcoFlow → Telegram: пороги розряду + світло + офлайн.
// Cron раз на хвилину, стан зберігається в KV.

type Env = {
	POWER_KV: KVNamespace
	ECOFLOW_ACCESS_KEY: string
	ECOFLOW_SECRET_KEY: string
	TELEGRAM_BOT_TOKEN: string
	TELEGRAM_CHAT_ID: string
}

// ── Налаштування ────────────────────────────────────────────────
const DEVICES = [{ sn: 'D3M1ZE1A9H990005', name: 'Маринка' }]
const THRESHOLDS = [50, 25, 10] // %
const RESET_GAP = 10 // поріг знову «зводиться», коли заряд піднявся на 10% вище за нього
const OFFLINE_ALERT_MIN = 30 // хв без зв'язку → попередження
const GRID_ALERTS = true // «Світло пішло / повернулось» по входу AC
const API = 'https://api-e.ecoflow.com'
// ────────────────────────────────────────────────────────────────

type DeviceState = {
	notified: number[] // пороги, про які вже повідомили
	grid: 'ON' | 'OFF' | null
	gridChangedAt: number | null
	offlineSince: number | null
	offlineAlerted: boolean
}

const emptyState = (): DeviceState => ({ notified: [], grid: null, gridChangedAt: null, offlineSince: null, offlineAlerted: false })

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function ecoflow(env: Env, path: string, params: Record<string, string> = {}) {
	const nonce = String(100000 + Math.floor(Math.random() * 900000))
	const timestamp = String(Date.now())
	const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
	const auth = `accessKey=${env.ECOFLOW_ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ECOFLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sign = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(query ? `${query}&${auth}` : auth)))
	const res = await fetch(`${API}${path}${query ? '?' + query : ''}`, {
		headers: { accessKey: env.ECOFLOW_ACCESS_KEY, nonce, timestamp, sign },
	})
	const json = await res.json<any>()
	if (json?.code !== '0') throw new Error(`EcoFlow ${path}: ${json?.code} ${json?.message}`)
	return json.data
}

async function telegram(env: Env, text: string) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
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

async function checkDevice(env: Env, dev: { sn: string; name: string }, online: boolean) {
	const kvKey = `dev:${dev.sn}`
	const raw = await env.POWER_KV.get(kvKey)
	const st: DeviceState = raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState()
	const before = JSON.stringify(st)
	const now = Date.now()

	// Офлайн: хмара віддає останні збережені дані, тому їм не віримо
	if (!online) {
		st.offlineSince ??= now
		if (!st.offlineAlerted && now - st.offlineSince >= OFFLINE_ALERT_MIN * 60000) {
			await telegram(env, `⚠️ ${dev.name}: немає зв'язку вже ${duration(now - st.offlineSince)}. Сповіщення про заряд не працюють.`)
			st.offlineAlerted = true
		}
		if (JSON.stringify(st) !== before) await env.POWER_KV.put(kvKey, JSON.stringify(st))
		return
	}
	if (st.offlineAlerted) await telegram(env, `✅ ${dev.name}: знову на зв'язку`)
	st.offlineSince = null
	st.offlineAlerted = false

	const q = await ecoflow(env, '/iot-open/sign/device/quota/all', { sn: dev.sn })
	const soc = Number(q.cmsBattSoc)
	const remMin = Number(q.cmsDsgRemTime)
	const outW = Number(q.powOutSumW ?? 0)
	const acInW = Number(q.powGetAcIn ?? 0)
	if (!Number.isFinite(soc)) throw new Error(`${dev.name}: немає cmsBattSoc`)

	// Пороги: повідомляємо один раз про найнижчий щойно перетнутий
	const crossed = THRESHOLDS.filter((t) => soc <= t && !st.notified.includes(t))
	if (crossed.length) {
		const t = Math.min(...crossed)
		const icon = t <= 10 ? '🚨' : t <= 25 ? '🪫' : '🔋'
		const rem = outW > 0 && Number.isFinite(remMin) ? `⏳ Залишилось ≈ ${hhmm(remMin)}` : '⏳ Навантаження 0 Вт'
		await telegram(env, `${icon} ${dev.name}: ${soc}%\n${rem}\n⚡ Споживання: ${outW} Вт`)
		st.notified.push(...crossed)
	}
	st.notified = st.notified.filter((t) => soc < t + RESET_GAP)

	// Світло по входу AC
	if (GRID_ALERTS) {
		const grid: 'ON' | 'OFF' = acInW > 0 ? 'ON' : 'OFF'
		if (st.grid && grid !== st.grid) {
			if (grid === 'OFF') {
				const rem = outW > 0 ? `\n⏳ ${dev.name} протягне ≈ ${hhmm(remMin)} (${soc}%)` : ''
				await telegram(env, `🪫 Світло пішло${rem}`)
			} else {
				const was = st.gridChangedAt ? `\n⏱ Не було: ${duration(now - st.gridChangedAt)}` : ''
				await telegram(env, `💡 Світло повернулось${was}\n🔋 ${dev.name}: ${soc}%`)
			}
			st.gridChangedAt = now
		}
		if (!st.grid) st.gridChangedAt = now
		st.grid = grid
	}

	if (JSON.stringify(st) !== before) await env.POWER_KV.put(kvKey, JSON.stringify(st))
}

async function run(env: Env) {
	const list: Array<{ sn: string; online: number }> = await ecoflow(env, '/iot-open/sign/device/list')
	const firstRun = !(await env.POWER_KV.get('started'))
	if (firstRun) {
		const lines = DEVICES.map((d) => `• ${d.name}: ${list.find((x) => x.sn === d.sn)?.online ? 'онлайн' : 'офлайн'}`)
		await telegram(env, `📡 Моніторинг EcoFlow запущено\nПороги: ${THRESHOLDS.join(' / ')}%\n${lines.join('\n')}`)
		await env.POWER_KV.put('started', String(Date.now()))
	}
	for (const dev of DEVICES) {
		const online = list.find((x) => x.sn === dev.sn)?.online === 1
		try {
			await checkDevice(env, dev, online)
		} catch (e) {
			console.error(dev.name, e)
		}
	}
}

export default {
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(run(env))
	},
	async fetch() {
		return new Response('ok')
	},
} satisfies ExportedHandler<Env>
