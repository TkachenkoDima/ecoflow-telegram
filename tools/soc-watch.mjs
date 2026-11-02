// Замір: які поля заряду Маринки в API оновлюються найшвидше.
// Запуск: ACCESS_KEY='...' SECRET_KEY='...' SN='серійник Маринки' node soc-watch.mjs
import crypto from 'node:crypto'
const { ACCESS_KEY, SECRET_KEY, SN } = process.env
if (!ACCESS_KEY || !SECRET_KEY || !SN) { console.error('Потрібні ACCESS_KEY, SECRET_KEY, SN'); process.exit(1) }
const HOST = process.env.API ?? 'https://api-e.ecoflow.com'
async function quota() {
  const nonce = String(Math.floor(100000 + Math.random() * 900000)), timestamp = String(Date.now())
  const query = `sn=${SN}`, auth = `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`
  const sign = crypto.createHmac('sha256', SECRET_KEY).update(`${query}&${auth}`).digest('hex')
  const r = await fetch(`${HOST}/iot-open/sign/device/quota/all?${query}`, { headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign } })
  const j = await r.json()
  if (j.code !== '0') throw new Error(`${j.code} ${j.message}`)
  return j.data
}
const ROUNDS = Number(process.env.ROUNDS ?? 10), EVERY = 30_000
let prev = {}
for (let i = 0; i < ROUNDS; i++) {
  const d = await quota()
  const keys = Object.keys(d).filter((k) => /soc/i.test(k) && typeof d[k] !== 'object').sort()
  const t = new Date().toLocaleTimeString('uk-UA')
  console.log(`\n── ${t}`)
  for (const k of keys) console.log(`${String(d[k]).padStart(8)}  ${k}${prev[k] !== undefined && prev[k] !== d[k] ? '   ← змінилось' : ''}`)
  prev = Object.fromEntries(keys.map((k) => [k, d[k]]))
  if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, EVERY))
}
