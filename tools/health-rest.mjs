// Здоров'я батареї через офіційний API: усі поля про SOH, цикли, ємність, температуру.
// Запуск: ACCESS_KEY='...' SECRET_KEY='...' node health-rest.mjs        ← серійники знайде сам
//     або: ACCESS_KEY='...' SECRET_KEY='...' SN='серійник' node health-rest.mjs
//     усі поля: ... ALL=1 SN='серійник' node health-rest.mjs > fields.txt
import crypto from 'node:crypto'
const { ACCESS_KEY, SECRET_KEY } = process.env
if (!ACCESS_KEY || !SECRET_KEY) { console.error('Потрібні ACCESS_KEY і SECRET_KEY'); process.exit(1) }
const HOST = process.env.API ?? 'https://api-e.ecoflow.com'
async function call(path, params = {}) {
  const nonce = String(Math.floor(100000 + Math.random() * 900000)), timestamp = String(Date.now())
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
  const auth = `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`
  const sign = crypto.createHmac('sha256', SECRET_KEY).update(query ? `${query}&${auth}` : auth).digest('hex')
  return (await fetch(`${HOST}${path}${query ? '?' + query : ''}`, { headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign } })).json()
}
const list = await call('/iot-open/sign/device/list')
if (list.code !== '0') { console.error(list.code, list.message); process.exit(1) }
console.log('Пристрої в акаунті:')
for (const d of list.data) console.log(`  ${d.sn}  ${d.deviceName ?? ''}  ${d.productName ?? ''}  ${d.online ? 'онлайн' : 'офлайн'}`)
const sns = process.env.SN ? [process.env.SN] : list.data.filter((d) => d.online).map((d) => d.sn)
for (const sn of sns) {
  const q = await call('/iot-open/sign/device/quota/all', { sn })
  console.log(`\n── ${sn}`)
  if (q.code !== '0') { console.log(`  API: ${q.code} ${q.message}`); continue }
  // ALL=1 — вивести всі поля (щоб пошукати очима)
  const keys = Object.keys(q.data).filter((k) => (process.env.ALL || /soh|cycle|cap|energy|full|design|temp|vol|health/i.test(k)) && typeof q.data[k] !== 'object').sort()
  if (!keys.length) console.log('  (немає полів про здоров\'я)')
  for (const k of keys) console.log(`${String(q.data[k]).padStart(10)}  ${k}`)
}
