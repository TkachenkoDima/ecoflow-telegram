// Схемо-незалежний protobuf-рідер + розбір пакетів EcoFlow River 3 (поля визначені з дампу).

type Field = { wt: number; int?: number; bytes?: Uint8Array; f32?: number }
type Fields = Map<number, Field[]>

function readVarint(b: Uint8Array, pos: number): [bigint, number] {
	let r = 0n,
		s = 0n,
		x: number
	do {
		if (pos >= b.length) throw new Error('varint overflow')
		x = b[pos++]
		r |= BigInt(x & 0x7f) << s
		s += 7n
	} while (x & 0x80)
	return [r, pos]
}

const toInt = (v: bigint) => Number(v > 0x7fffffffffffffffn ? v - 0x10000000000000000n : v)

export function decode(b: Uint8Array): Fields {
	const out: Fields = new Map()
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
	let pos = 0
	while (pos < b.length) {
		let tag: bigint
		;[tag, pos] = readVarint(b, pos)
		const fn = Number(tag >> 3n),
			wt = Number(tag & 7n)
		let f: Field
		if (wt === 0) {
			let v: bigint
			;[v, pos] = readVarint(b, pos)
			f = { wt, int: toInt(v) }
		} else if (wt === 5) {
			f = { wt, f32: view.getFloat32(pos, true) }
			pos += 4
		} else if (wt === 1) {
			f = { wt, f32: view.getFloat64(pos, true) }
			pos += 8
		} else if (wt === 2) {
			let l: bigint
			;[l, pos] = readVarint(b, pos)
			const n = Number(l)
			f = { wt, bytes: b.subarray(pos, pos + n) }
			pos += n
		} else throw new Error(`wire type ${wt}`)
		if (pos > b.length) throw new Error('truncated')
		if (!out.has(fn)) out.set(fn, [])
		out.get(fn)!.push(f)
	}
	return out
}

const num = (m: Fields, fn: number): number | undefined => {
	const f = m.get(fn)?.[0]
	return f ? (f.f32 ?? f.int) : undefined
}

// Часткові дані однієї UPS з одного MQTT-повідомлення
export type UpsPart = {
	soc?: number // %, BMS heartbeat (32/50) поле 25 (float) або 6
	remMin?: number // хв, BMS 32/50 поле 28
	battInW?: number // BMS 32/50 поле 26
	battOutW?: number // BMS 32/50 поле 27
	inSumW?: number // 254/21 поле 3 — загальний вхід (мережа/сонце)
	outSumW?: number // 254/21 поле 4 — загальне споживання
	maxChg?: number // 254/21 поле 270 — ліміт заряду, %
	acMax?: number // 254/21 поле 209 — макс. вхідна потужність AC, Вт
	minDsg?: number // 254/21 поле 271 — мін. розряд, %
}

export function parseEcoflowPacket(payload: Uint8Array): UpsPart {
	const part: UpsPart = {}
	for (const h of decode(payload).get(1) ?? []) {
		if (!h.bytes) continue
		const hdr = decode(h.bytes)
		const pdataRaw = hdr.get(1)?.[0]?.bytes
		if (!pdataRaw) continue
		const pdata = new Uint8Array(pdataRaw)
		const src = num(hdr, 2) ?? 0,
			encType = num(hdr, 6) ?? 0,
			cmdFunc = num(hdr, 8),
			cmdId = num(hdr, 9),
			seq = num(hdr, 14) ?? 0
		if (encType === 1 && src !== 32) for (let i = 0; i < pdata.length; i++) pdata[i] ^= seq & 0xff
		let m: Fields
		try {
			m = decode(pdata)
		} catch {
			continue
		}
		if (cmdFunc === 32 && cmdId === 50) {
			part.soc = num(m, 25) ?? num(m, 6)
			part.battInW = num(m, 26)
			part.battOutW = num(m, 27)
			part.remMin = num(m, 28)
		} else if (cmdFunc === 254 && cmdId === 21) {
			const inW = num(m, 3),
				outW = num(m, 4)
			if (inW !== undefined) part.inSumW = inW
			if (outW !== undefined) part.outSumW = outW
			const mx = num(m, 270),
				ac = num(m, 209)
			if (mx !== undefined) part.maxChg = mx
			if (ac !== undefined) part.acMax = ac
			const mn = num(m, 271)
			if (mn !== undefined) part.minDsg = mn
		}
	}
	return part
}

// ── Кодування команди запису для River 3 (схема з hassio-ecoflow-cloud: ef_river3.proto) ──
const varint = (n: number) => {
	const out: number[] = []
	let v = BigInt(n)
	if (v < 0n) v += 1n << 64n
	do {
		let b = Number(v & 0x7fn)
		v >>= 7n
		if (v > 0n) b |= 0x80
		out.push(b)
	} while (v > 0n)
	return out
}
const fVar = (field: number, n: number) => [...varint((field << 3) | 0), ...varint(n)]
const fBytes = (field: number, b: number[]) => [...varint((field << 3) | 2), ...varint(b.length), ...b]

// SetCommand (River 3 / DELTA 3): пари [поле, значення] int32
// напр. [[33, 80]] = ліміт заряду 80%; [[54, 500], [125, 0]] = вхід AC 500 Вт для DELTA 3
// (поле 125 = 0 — «застосувати», без нього DELTA 3 мовчки ігнорує поле 54; так шле застосунок)
export function encodeSetCommand(sn: string, fields: [number, number][]): Uint8Array {
	const pdata = fields.flatMap(([f, v]) => fVar(f, v))
	const header = [
		...fBytes(1, pdata), // pdata
		...fVar(2, 32), // src
		...fVar(3, 2), // dest
		...fVar(4, 1), // d_src
		...fVar(5, 1), // d_dest
		...fVar(8, 254), // cmd_func
		...fVar(9, 17), // cmd_id
		...fVar(10, pdata.length), // data_len
		...fVar(11, 1), // need_ack
		...fVar(14, Math.floor(Math.random() * 1e9)), // seq
		...fVar(15, 1), // product_id
		...fVar(16, 19), // version
		...fVar(17, 1), // payload_ver
		...fBytes(25, [...new TextEncoder().encode(sn)]), // device_sn
	]
	return new Uint8Array(fBytes(1, header)) // River3SendHeaderMsg { repeated header msg = 1 }
}
