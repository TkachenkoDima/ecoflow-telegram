// Зонд: логін як застосунок EcoFlow → MQTT → 2 хв слухаємо станції → probe-dump.jsonl
// Запуск: EF_EMAIL='...' EF_PASSWORD='...' node probe.mjs
import mqtt from 'mqtt'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

const DEVICES = {
  D3M1ZE1A9H990005: 'Маринка',
  R655ZEBAXH170579: 'UPS Kate',
  R655ZEBAXH171200: 'UPS Router',
}
const SECONDS = Number(process.env.SECONDS ?? 120)
const OUT = process.env.OUT ?? 'probe-dump.jsonl'
const { EF_EMAIL, EF_PASSWORD } = process.env
if (!EF_EMAIL || !EF_PASSWORD) { console.error('Задай EF_EMAIL і EF_PASSWORD'); process.exit(1) }

async function login(domain) {
  const r = await fetch(`https://${domain}/auth/login`, {
    method: 'POST',
    headers: { lang: 'en_US', 'content-type': 'application/json' },
    body: JSON.stringify({ email: EF_EMAIL, password: Buffer.from(EF_PASSWORD).toString('base64'), scene: 'IOT_APP', userType: 'ECOFLOW' }),
  })
  const j = await r.json()
  if (j.code !== '0') throw new Error(`login ${domain}: ${j.code} ${j.message}`)
  return { token: j.data.token, userId: j.data.user.userId }
}

// ── схемо-незалежний protobuf-декодер ──
function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b
  do { b = buf[pos++]; result |= BigInt(b & 0x7f) << shift; shift += 7n } while (b & 0x80)
  return [result, pos]
}
function decodePb(buf, depth = 0) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    let tag; [tag, pos] = readVarint(buf, pos)
    const field = Number(tag >> 3n), wt = Number(tag & 7n)
    if (field === 0) throw new Error('bad field')
    if (wt === 0) { let v; [v, pos] = readVarint(buf, pos); out.push([field, 'v', v.toString()]) }
    else if (wt === 1) { out.push([field, 'f64', buf.readDoubleLE(pos)]); pos += 8 }
    else if (wt === 5) { out.push([field, 'f32', +buf.readFloatLE(pos).toFixed(3), buf.readUInt32LE(pos)]); pos += 4 }
    else if (wt === 2) {
      let len; [len, pos] = readVarint(buf, pos); len = Number(len)
      const sub = buf.subarray(pos, pos + len); pos += len
      let nested = null
      if (depth < 4 && sub.length) { try { nested = decodePb(sub, depth + 1) } catch {} }
      out.push([field, 'b', nested ?? sub.toString('hex')])
    } else throw new Error('wt ' + wt)
    if (pos > buf.length) throw new Error('overflow')
  }
  return out
}
// HeaderMessage { repeated Header header = 1 }, Header: pdata=1 src=2 enc_type=6 cmd_func=8 cmd_id=9 seq=14
function decodeEcoflow(buf) {
  const msgs = []
  for (const [f, , hdr] of decodePb(buf)) {
    if (f !== 1 || !Array.isArray(hdr)) continue
    const get = (n) => hdr.find((x) => x[0] === n)
    const raw = get(1)
    let pdata = raw ? Buffer.from(Array.isArray(raw[2]) ? '' : raw[2], 'hex') : Buffer.alloc(0)
    // pdata міг розпарситись як nested — дістаємо байти заново
    const encType = Number(get(6)?.[2] ?? 0), src = Number(get(2)?.[2] ?? 0), seq = Number(get(14)?.[2] ?? 0)
    msgs.push({ cmdFunc: Number(get(8)?.[2] ?? -1), cmdId: Number(get(9)?.[2] ?? -1), encType, src, seq, hdr })
  }
  return msgs
}
// Витягуємо сирі pdata байти + XOR, якщо enc_type=1
function extractPdata(buf) {
  const res = []
  let pos = 0
  while (pos < buf.length) {
    let tag; [tag, pos] = readVarint(buf, pos)
    const field = Number(tag >> 3n), wt = Number(tag & 7n)
    if (wt !== 2) { if (wt === 0) [, pos] = readVarint(buf, pos); else pos += wt === 1 ? 8 : 4; continue }
    let len; [len, pos] = readVarint(buf, pos); len = Number(len)
    const hdrBuf = buf.subarray(pos, pos + len); pos += len
    if (field !== 1) continue
    // всередині Header
    let p = 0, pdata = null, encType = 0, src = 0, seq = 0, cmdFunc = -1, cmdId = -1
    while (p < hdrBuf.length) {
      let t; [t, p] = readVarint(hdrBuf, p)
      const f = Number(t >> 3n), w = Number(t & 7n)
      if (w === 2) { let l; [l, p] = readVarint(hdrBuf, p); l = Number(l); if (f === 1) pdata = Buffer.from(hdrBuf.subarray(p, p + l)); p += l }
      else if (w === 0) { let v; [v, p] = readVarint(hdrBuf, p); v = Number(v)
        if (f === 2) src = v; if (f === 6) encType = v; if (f === 8) cmdFunc = v; if (f === 9) cmdId = v; if (f === 14) seq = v }
      else p += w === 1 ? 8 : 4
    }
    if (pdata && encType === 1 && src !== 32) for (let i = 0; i < pdata.length; i++) pdata[i] ^= seq & 0xff
    let fields = null
    try { fields = pdata ? decodePb(pdata) : null } catch (e) { fields = 'undecodable' }
    res.push({ cmdFunc, cmdId, encType, src, seq, pdataHex: pdata?.toString('hex'), fields })
  }
  return res
}

let auth, domain
for (const d of ['api-e.ecoflow.com', 'api.ecoflow.com']) {
  try { auth = await login(d); domain = d; break } catch (e) { console.log(String(e.message)) }
}
if (!auth) process.exit(1)
console.log(`✅ Логін OK (${domain}), userId ${auth.userId}`)

const cr = await fetch(`https://${domain}/iot-auth/app/certification?userId=${auth.userId}`, {
  headers: { lang: 'en_US', authorization: `Bearer ${auth.token}` },
})
const cj = await cr.json()
if (cj.code !== '0') { console.error('certification:', cj.code, cj.message); process.exit(1) }
const c = cj.data
console.log(`✅ MQTT: ${c.protocol}://${c.url}:${c.port}`)

writeFileSync(OUT, '')
const client = mqtt.connect(`${c.protocol === 'mqtts' ? 'mqtts' : 'mqtts'}://${c.url}:${c.port}`, {
  username: c.certificateAccount,
  password: c.certificatePassword,
  clientId: `ANDROID_${randomUUID().replace(/-/g, '').toUpperCase()}_${auth.userId}`,
  protocolVersion: 4,
  reconnectPeriod: 0,
})
const counts = {}
client.on('connect', () => {
  console.log('✅ MQTT підключено, слухаю', SECONDS, 'сек...')
  for (const sn of Object.keys(DEVICES)) {
    client.subscribe([`/app/device/property/${sn}`, `/app/${auth.userId}/${sn}/thing/property/get_reply`])
    // запит "дай усе" (JSON-варіант, для старих пристроїв)
    client.publish(`/app/${auth.userId}/${sn}/thing/property/get`, JSON.stringify({ from: 'Android', id: String(Date.now() % 1e9), version: '1.1', moduleType: 0, operateType: 'latestQuotas', params: {} }))
  }
})
client.on('error', (e) => { console.error('MQTT error:', e.message) })
client.on('message', (topic, payload) => {
  const sn = Object.keys(DEVICES).find((s) => topic.includes(s))
  const name = DEVICES[sn] ?? topic
  counts[name] = (counts[name] ?? 0) + 1
  let rec = { t: Date.now(), name, topic, len: payload.length }
  try { rec.json = JSON.parse(payload.toString('utf8')) }
  catch { rec.hex = payload.toString('hex'); try { rec.pb = extractPdata(payload) } catch (e) { rec.pbErr = String(e) } }
  appendFileSync(OUT, JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n')
  process.stdout.write(`\r📨 ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | ')}   `)
})
setTimeout(() => {
  console.log(`\n\nГотово. Повідомлень: ${JSON.stringify(counts)}. Дамп: ${OUT}`)
  client.end(true); process.exit(0)
}, SECONDS * 1000)
