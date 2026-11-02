// Здоров'я батареї станції через офіційний API (DELTA 3 / Маринка): усі поля про SOH, цикли, ємність, температуру.
// Запуск: ACCESS_KEY='...' SECRET_KEY='...' SN='серійник' node health-rest.mjs
import crypto from 'node:crypto'
const { ACCESS_KEY, SECRET_KEY, SN } = process.env
if (!ACCESS_KEY || !SECRET_KEY || !SN) { console.error('Потрібні ACCESS_KEY, SECRET_KEY, SN'); process.exit(1) }
const HOST = process.env.API ?? 'https://api-e.ecoflow.com'
const nonce = String(Math.floor(100000 + Math.random() * 900000)), timestamp = String(Date.now())
const query = `sn=${SN}`, auth = `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`
const sign = crypto.createHmac('sha256', SECRET_KEY).update(`${query}&${auth}`).digest('hex')
const j = await (await fetch(`${HOST}/iot-open/sign/device/quota/all?${query}`, { headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign } })).json()
if (j.code !== '0') { console.error(j.code, j.message); process.exit(1) }
const keys = Object.keys(j.data).filter((k) => /soh|cycle|cap|temp|vol|health/i.test(k) && typeof j.data[k] !== 'object').sort()
for (const k of keys) console.log(`${String(j.data[k]).padStart(10)}  ${k}`)
