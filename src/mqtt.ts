// Мінімальний MQTT 3.1.1 клієнт поверх TLS-сокетів Cloudflare (QoS 0, лише підписка).
import { connect } from 'cloudflare:sockets'

const enc = new TextEncoder()
const dec = new TextDecoder()

const mqttStr = (s: string) => {
	const b = enc.encode(s)
	return [b.length >> 8, b.length & 0xff, ...b]
}
const remLen = (n: number) => {
	const out: number[] = []
	do {
		let d = n % 128
		n = Math.floor(n / 128)
		if (n > 0) d |= 0x80
		out.push(d)
	} while (n > 0)
	return out
}
const packet = (type: number, body: number[]) => new Uint8Array([type, ...remLen(body.length), ...body])

export type MqttMessage = { topic: string; payload: Uint8Array }

export class MqttAuthError extends Error {}

export async function mqttCollect(opts: {
	host: string
	port: number
	username: string
	password: string
	clientId: string
	topics: string[]
	timeoutMs: number
	onMessage: (m: MqttMessage) => boolean // true = зібрали все, можна відключатись
	publish?: { topic: string; payload: Uint8Array } // надіслати одразу після підписки (QoS 0)
}): Promise<void> {
	const socket = connect({ hostname: opts.host, port: opts.port }, { secureTransport: 'on', allowHalfOpen: false })
	const writer = socket.writable.getWriter()
	const reader = socket.readable.getReader()
	const deadline = Date.now() + opts.timeoutMs
	let buf = new Uint8Array(0)
	let connected = false

	try {
		await writer.write(
			packet(0x10, [...mqttStr('MQTT'), 4, 0xc2, 0, 60, ...mqttStr(opts.clientId), ...mqttStr(opts.username), ...mqttStr(opts.password)]),
		)

		while (Date.now() < deadline) {
			const left = deadline - Date.now()
			const r = await Promise.race([
				reader.read(),
				new Promise<{ timeout: true }>((res) => setTimeout(() => res({ timeout: true }), left)),
			])
			if ('timeout' in r) break
			if (r.done) break
			const merged = new Uint8Array(buf.length + r.value.length)
			merged.set(buf)
			merged.set(r.value, buf.length)
			buf = merged

			// розбираємо всі повні пакети з буфера
			while (buf.length >= 2) {
				let mult = 1,
					len = 0,
					i = 1,
					d: number
				do {
					if (i >= buf.length) break
					d = buf[i++]
					len += (d & 0x7f) * mult
					mult *= 128
				} while (d & 0x80)
				if (i + len > buf.length) break
				const type = buf[0] >> 4
				const flags = buf[0] & 0x0f
				const body = buf.subarray(i, i + len)
				buf = buf.slice(i + len)

				if (type === 2) {
					// CONNACK
					if (body[1] !== 0) throw new MqttAuthError(`MQTT CONNACK rc=${body[1]}`)
					connected = true
					await writer.write(packet(0x82, [0, 1, ...opts.topics.flatMap((t) => [...mqttStr(t), 0])]))
					if (opts.publish) await writer.write(packet(0x30, [...mqttStr(opts.publish.topic), ...opts.publish.payload]))
				} else if (type === 3) {
					// PUBLISH
					const qos = (flags >> 1) & 3
					const tl = (body[0] << 8) | body[1]
					const topic = dec.decode(body.subarray(2, 2 + tl))
					let p = 2 + tl
					if (qos > 0) {
						await writer.write(new Uint8Array([0x40, 2, body[p], body[p + 1]])) // PUBACK
						p += 2
					}
					if (opts.onMessage({ topic, payload: body.slice(p) })) return
				}
			}
		}
		if (!connected) throw new Error('MQTT: немає CONNACK')
	} finally {
		try {
			await writer.write(new Uint8Array([0xe0, 0]))
		} catch {}
		try {
			await socket.close()
		} catch {}
	}
}
