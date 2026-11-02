// Здоров'я батарей River 3 / UPS з дампу probe.mjs (пакет BMS 32/50).
// 1) EF_EMAIL='...' EF_PASSWORD='...' SECONDS=60 OUT=health-dump.jsonl node probe.mjs SN_KATE SN_ROUTER
// 2) node health.mjs health-dump.jsonl
import { readFileSync } from 'node:fs'

function readVarint(b, pos) {
  let r = 0n, s = 0n, x
  do { x = b[pos++]; r |= BigInt(x & 0x7f) << s; s += 7n } while (x & 0x80)
  return [r, pos]
}
function decode(b) {
  const out = new Map(), view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let pos = 0
  while (pos < b.length) {
    let tag; [tag, pos] = readVarint(b, pos)
    const fn = Number(tag >> 3n), wt = Number(tag & 7n)
    let f
    if (wt === 0) { let v; [v, pos] = readVarint(b, pos); f = { int: Number(v) } }
    else if (wt === 5) { f = { num: view.getFloat32(pos, true) }; pos += 4 }
    else if (wt === 1) { f = { num: view.getFloat64(pos, true) }; pos += 8 }
    else if (wt === 2) { let l; [l, pos] = readVarint(b, pos); f = { bytes: b.subarray(pos, pos + Number(l)) }; pos += Number(l) }
    else throw new Error('wt ' + wt)
    if (!out.has(fn)) out.set(fn, [])
    out.get(fn).push(f)
  }
  return out
}
const num = (m, fn) => { const f = m.get(fn)?.[0]; return f ? (f.num ?? f.int) : undefined }

const file = process.argv[2] ?? 'health-dump.jsonl'
const last = new Map()
for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
  const L = JSON.parse(line)
  if (!L.hex) continue
  let top
  try { top = decode(Uint8Array.from(Buffer.from(L.hex, 'hex'))) } catch { continue }
  for (const h of top.get(1) ?? []) {
    if (!h.bytes) continue
    const hdr = decode(h.bytes), raw = hdr.get(1)?.[0]?.bytes
    if (!raw) continue
    const p = new Uint8Array(raw), src = num(hdr, 2) ?? 0, enc = num(hdr, 6) ?? 0, seq = num(hdr, 14) ?? 0
    if (num(hdr, 8) !== 32 || num(hdr, 9) !== 50) continue
    if (enc === 1 && src !== 32) for (let i = 0; i < p.length; i++) p[i] ^= seq & 0xff
    try { last.set(L.name, decode(p)) } catch {}
  }
}
if (!last.size) { console.log('У дампі немає пакетів BMS (32/50). Запустіть probe.mjs довше (SECONDS=90).'); process.exit(0) }
for (const [sn, m] of last) {
  const design = num(m, 11), full = num(m, 13), remain = num(m, 12)
  console.log(`\n🔋 ${sn}`)
  console.log(`  Здоров'я (SOH, оцінка BMS):  ${num(m, 15)}%`)
  console.log(`  Ємність: повна ${(full / 1000).toFixed(2)} А·год з паспортних ${(design / 1000).toFixed(2)} → ${((full / design) * 100).toFixed(1)}%`)
  console.log(`  Цикли заряду:                ${num(m, 14)}`)
  console.log(`  Заряд зараз:                 ${Math.round(num(m, 25) ?? num(m, 6))}% (${(remain / 1000).toFixed(2)} А·год)`)
  console.log(`  Напруга батареї:             ${(num(m, 7) / 1000).toFixed(2)} В`)
  console.log(`  Комірки: макс ${num(m, 16)} мВ, мін ${num(m, 17)} мВ, розкид ${num(m, 16) - num(m, 17)} мВ`)
  console.log(`  Температура: ${num(m, 9)} °C (комірки ${num(m, 19)}–${num(m, 18)} °C)`)
}
