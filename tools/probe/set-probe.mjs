// Зонд запису: надсилає одну команду SetCommand (protobuf) і 15 с пише ВСЕ, що приходить від станції.
// Запуск: EF_EMAIL='...' EF_PASSWORD='...' node set-probe.mjs <SN> <поле> <значення>
//   напр. node set-probe.mjs R655ZEBAXH170579 33 90   (Kate: ліміт заряду 90%)
import mqtt from 'mqtt'
import { randomUUID } from 'node:crypto'

const [SN, FIELD, VALUE] = process.argv.slice(2)
const { EF_EMAIL, EF_PASSWORD } = process.env
if (!SN || !FIELD || !VALUE || !EF_EMAIL || !EF_PASSWORD) { console.error('node set-probe.mjs <SN> <поле> <значення> + EF_EMAIL/EF_PASSWORD'); process.exit(1) }
const API = 'https://api-e.ecoflow.com'

// protobuf-кодування (як у src/protobuf.ts)
const varint = (n) => { const o = []; let v = BigInt(n); if (v < 0n) v += 1n << 64n; do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; o.push(b) } while (v > 0n); return o }
const fVar = (f, n) => [...varint((f << 3) | 0), ...varint(n)]
const fBytes = (f, b) => [...varint((f << 3) | 2), ...varint(b.length), ...b]
const pdata = fVar(Number(FIELD), Number(VALUE))
const seq = Math.floor(Math.random() * 1e9)
const header = [...fBytes(1, pdata), ...fVar(2, 32), ...fVar(3, 2), ...fVar(4, 1), ...fVar(5, 1), ...fVar(8, 254), ...fVar(9, 17), ...fVar(10, pdata.length), ...fVar(11, 1), ...fVar(14, seq), ...fVar(15, 1), ...fVar(16, 19), ...fVar(17, 1), ...fBytes(25, [...Buffer.from(SN)])]
const payload = Buffer.from(fBytes(1, header))

// простий розбір заголовка відповіді
const rv = (b, p) => { let r = 0n, s = 0n, x; do { x = b[p++]; r |= BigInt(x & 0x7f) << s; s += 7n } while (x & 0x80); return [r, p] }
function fields(b) { const o = {}; let p = 0; try { while (p < b.length) { let t; [t, p] = rv(b, p); const f = Number(t >> 3n), w = Number(t & 7n); if (w === 0) { let v; [v, p] = rv(b, p); o[f] = Number(v) } else if (w === 2) { let l; [l, p] = rv(b, p); o[f] = b.subarray(p, p + Number(l)); p += Number(l) } else if (w === 5) { o[f] = b.readFloatLE(p); p += 4 } else if (w === 1) p += 8; else break } } catch {} return o }
function describe(buf) {
  try { return 'JSON ' + JSON.stringify(JSON.parse(buf.toString())).slice(0, 300) } catch {}
  const outer = fields(buf); if (!outer[1]) return 'hex ' + buf.toString('hex').slice(0, 120)
  const h = fields(outer[1]); let pd = h[1] ? Buffer.from(h[1]) : Buffer.alloc(0)
  if (h[6] === 1 && h[2] !== 32) for (let i = 0; i < pd.length; i++) pd[i] ^= (h[14] ?? 0) & 0xff
  const pf = fields(pd)
  return `cmd ${h[8]}/${h[9]} src ${h[2]} seq ${h[14]}${h[14] === seq ? ' (НАША)' : ''} pdata ${JSON.stringify(Object.fromEntries(Object.entries(pf).filter(([, v]) => typeof v === 'number')))}`.slice(0, 400)
}

const lj = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { lang: 'en_US', 'content-type': 'application/json' }, body: JSON.stringify({ email: EF_EMAIL, password: Buffer.from(EF_PASSWORD).toString('base64'), scene: 'IOT_APP', userType: 'ECOFLOW' }) })).json()
if (lj.code !== '0') { console.error('login', lj.code, lj.message); process.exit(1) }
const userId = lj.data.user.userId
const c = (await (await fetch(`${API}/iot-auth/app/certification?userId=${userId}`, { headers: { lang: 'en_US', authorization: `Bearer ${lj.data.token}` } })).json()).data
const client = mqtt.connect(`mqtts://${c.url}:${c.port}`, { username: c.certificateAccount, password: c.certificatePassword, clientId: `ANDROID_${randomUUID().replace(/-/g, '').toUpperCase()}_${userId}`, protocolVersion: 4, reconnectPeriod: 0 })
client.on('connect', () => {
  client.subscribe(`/app/${userId}/${SN}/#`)
  client.subscribe(`/app/device/property/${SN}`, () => {
    console.log(`✅ підключено. Надсилаю: поле ${FIELD} = ${VALUE}, seq ${seq}`)
    client.publish(`/app/${userId}/${SN}/thing/property/set`, payload, { qos: 1 }, (e) => console.log(e ? `❌ publish: ${e.message}` : '📤 команду надіслано (брокер прийняв)'))
  })
})
client.on('error', (e) => console.error('MQTT error:', e.message))
client.on('message', (topic, buf) => {
  if (topic.endsWith('/set')) return // наше ж повідомлення
  const d = describe(buf)
  if (topic.includes('property/' + SN) && !d.includes('254/18') && !d.includes('НАША') && !/\b(33|54)\b/.test(d)) return // шум телеметрії
  console.log(`📨 ${topic.replace(String(userId), '<uid>')}\n   ${d}`)
})
setTimeout(() => { console.log('Готово.'); client.end(true); process.exit(0) }, 15000)
