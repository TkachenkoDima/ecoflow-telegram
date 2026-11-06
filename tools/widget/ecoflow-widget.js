// Віджет EcoFlow для iPhone (застосунок Scriptable).
// 1) Встав свої URL і KEY нижче. 2) Додай віджет Scriptable на екран і вибери цей скрипт.
// Параметр віджета (Parameter): cmd станції для маленького віджета (marinka / kate / router). Порожньо — перша станція.
const URL = 'https://frosty-union-469b.frosty-union-469b.workers.dev/widget'
const KEY = '0d876123a3a24bc3ee030499eba00b11'

const C = {
  bg1: new Color('#16191f'), bg2: new Color('#0d0f13'),
  text: Color.white(), dim: new Color('#8b93a1'),
  green: new Color('#34c759'), yellow: new Color('#ffcc00'), orange: new Color('#ff9500'), red: new Color('#ff3b30'),
  track: new Color('#2a2f38'),
}
const socColor = (s) => (s <= 10 ? C.red : s <= 25 ? C.orange : s <= 50 ? C.yellow : C.green)
const pad = (n) => String(n).padStart(2, '0')
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(Math.round(min) % 60)}`
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function dur(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m} хв`
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `${d} д ${h} год`
  return `${h} год${mm ? ` ${mm} хв` : ''}`
}
const stateText = (s) => (!s.online ? 'офлайн' : s.soc === null ? 'немає даних' : s.remMin !== null ? `⏳ ${hhmm(s.remMin)}` : s.fromGrid ? '🔌 від мережі' : '⏳ —')
const lightText = (l, now) => (!l ? '' : `${l.on ? '🟢 Світло є' : '🔴 Без світла'} · ${dur(now - l.since)}`)

function bar(soc, w, h) {
  const ctx = new DrawContext()
  ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true
  const r = h / 2
  const p = new Path(); p.addRoundedRect(new Rect(0, 0, w, h), r, r); ctx.addPath(p); ctx.setFillColor(C.track); ctx.fillPath()
  const fw = Math.max(h, (w * Math.max(0, Math.min(100, soc))) / 100)
  const f = new Path(); f.addRoundedRect(new Rect(0, 0, fw, h), r, r); ctx.addPath(f); ctx.setFillColor(socColor(soc)); ctx.fillPath()
  return ctx.getImage()
}
function txt(stack, s, size, color = C.text, bold = false) {
  const t = stack.addText(s); t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size); t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.7
  return t
}
function bg(w) { const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g }

async function load() {
  const req = new Request(`${URL}?key=${encodeURIComponent(KEY)}`)
  req.timeoutInterval = 45
  return req.loadJSON()
}

function small(w, d, cmd) {
  const s = d.stations.find((x) => x.cmd === cmd) ?? d.stations[0]
  txt(w, s.name, 13, C.dim, true)
  w.addSpacer(2)
  txt(w, s.soc === null ? '—' : `${s.soc}%`, 34, s.soc === null ? C.dim : socColor(s.soc), true)
  w.addSpacer(4)
  if (s.soc !== null) w.addImage(bar(s.soc, 120, 7)).imageSize = new Size(120, 7)
  w.addSpacer(6)
  txt(w, stateText(s), 12, C.text)
  w.addSpacer()
  txt(w, lightText(d.light, Date.now()), 11, d.light?.on ? C.green : C.red)
}

function list(w, d, detail) {
  txt(w, lightText(d.light, Date.now()), detail ? 15 : 13, d.light?.on ? C.green : C.red, true)
  w.addSpacer(detail ? 10 : 6)
  for (const s of d.stations) {
    const row = w.addStack(); row.centerAlignContent()
    const name = row.addStack(); name.size = new Size(detail ? 80 : 70, 0); txt(name, s.name, 13, C.text, true)
    const pct = row.addStack(); pct.size = new Size(44, 0); txt(pct, s.soc === null ? '—' : `${s.soc}%`, 13, s.soc === null ? C.dim : socColor(s.soc), true)
    if (s.soc !== null) row.addImage(bar(s.soc, 60, 6)).imageSize = new Size(60, 6)
    else row.addSpacer(60)
    row.addSpacer(8)
    txt(row, stateText(s) + (detail && s.loadW ? ` · ⚡ ${s.loadW} Вт` : ''), 12, C.dim)
    row.addSpacer()
    w.addSpacer(detail ? 8 : 4)
  }
}

function footer(w, d) {
  w.addSpacer()
  const f = w.addStack(); f.addSpacer(); txt(f, `оновлено ${clock(d.at)}`, 9, C.dim)
}

async function main() {
  const fam = config.widgetFamily ?? 'medium'
  const cmd = (args.widgetParameter || '').trim().toLowerCase()
  const w = new ListWidget()
  w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000)
  let d
  try { d = await load() } catch (e) {
    if (fam.startsWith('accessory')) { w.addText('EcoFlow: немає даних') } else { bg(w); txt(w, 'EcoFlow', 13, C.dim, true); w.addSpacer(4); txt(w, 'Немає даних', 14, C.red, true); txt(w, String(e).slice(0, 80), 10, C.dim) }
    return w
  }
  if (fam === 'accessoryInline') {
    const s = d.stations.find((x) => x.cmd === cmd) ?? d.stations[0]
    w.addText(`${d.light?.on ? '🟢' : '🔴'} ${s.name} ${s.soc ?? '—'}%`)
  } else if (fam === 'accessoryCircular') {
    const s = d.stations.find((x) => x.cmd === cmd) ?? d.stations[0]
    w.addSpacer(); const t = w.addText(`${s.soc ?? '—'}%`); t.font = Font.boldSystemFont(16); t.centerAlignText()
    const l = w.addText(d.light?.on ? '●' : '○'); l.font = Font.systemFont(10); l.centerAlignText(); w.addSpacer()
  } else if (fam === 'accessoryRectangular') {
    const t = w.addText(lightText(d.light, Date.now())); t.font = Font.boldSystemFont(12)
    for (const s of d.stations) { const r = w.addText(`${s.name} ${s.soc ?? '—'}% · ${stateText(s)}`); r.font = Font.systemFont(11); r.lineLimit = 1 }
  } else {
    bg(w); w.setPadding(14, 14, 10, 14)
    if (fam === 'small') small(w, d, cmd)
    else list(w, d, fam === 'large' || fam === 'extraLarge')
    if (fam !== 'small') footer(w, d)
  }
  return w
}

const widget = await main()
if (config.runsInWidget) Script.setWidget(widget)
else await widget.presentMedium()
Script.complete()
