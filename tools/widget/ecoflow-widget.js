// Віджет EcoFlow для iPhone (застосунок Scriptable).
// Ключ у файлі не зберігається: при першому запуску в застосунку скрипт спитає WIDGET_TOKEN і покладе його в Keychain телефона.
// Parameter віджета (через пробіл, у будь-якому порядку):
//   станція — router / kate / marinka, або 1 / 2 / 3, або назва (Маринка); порожньо — перша
//   тема    — auto (за темою iPhone, типово) / glass (темне скло) / light (світле скло)
// Приклади: «kate», «2 light», «marinka glass».
const URL = 'https://frosty-union-469b.frosty-union-469b.workers.dev/widget'
const KC = 'ecoflow_widget_key'

// ---------- кольори ----------
const hex = (h, a = 1) => new Color(h, a)
const dyn = (l, d) => Color.dynamic(l, d)
const THEMES = {
  glass: { bg: [hex('#26354a'), hex('#0e141d')], card: hex('#ffffff', 0.09), edge: hex('#ffffff', 0.22), text: hex('#ffffff'), dim: hex('#ffffff', 0.6) },
  light: { bg: [hex('#f3f6fa'), hex('#d5dee9')], card: hex('#ffffff', 0.55), edge: hex('#ffffff', 0.95), text: hex('#11161d'), dim: hex('#11161d', 0.55) },
}
THEMES.auto = Object.fromEntries(Object.keys(THEMES.glass).map((k) =>
  [k, k === 'bg' ? THEMES.glass.bg.map((c, i) => dyn(THEMES.light.bg[i], c)) : dyn(THEMES.light[k], THEMES.glass[k])]))
const GREEN = hex('#30d158'), YELLOW = hex('#ffd60a'), ORANGE = hex('#ff9f0a'), RED = hex('#ff453a'), TRACK = hex('#8e8e93', 0.28)
const socColor = (s) => (s <= 10 ? RED : s <= 25 ? ORANGE : s <= 50 ? YELLOW : GREEN)

// ---------- текст ----------
const pad = (n) => String(n).padStart(2, '0')
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m} хв`
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return `${d} д ${h} год`
  return `${h} год${mm ? ` ${mm} хв` : ''}`
}
const stateText = (s) => (s.staleAt ? `дані о ${clock(s.staleAt)}` : !s.online ? 'офлайн' : s.soc === null ? 'немає даних' : s.remMin !== null ? `ще ${dur(s.remMin * 60000)}` : s.fromGrid ? 'від мережі' : '—')
const stateIcon = (s) => (s.staleAt ? 'clock' : !s.online ? 'wifi.slash' : s.remMin !== null ? 'hourglass' : s.fromGrid ? 'powerplug.fill' : 'hourglass')
const lightText = (l, now) => (!l ? 'Світло: —' : `${l.on ? 'Світло є' : 'Без світла'} · ${dur(now - l.since)}`)

// ---------- графіка ----------
function ring(soc, size, line) {
  const ctx = new DrawContext(); ctx.size = new Size(size, size); ctx.opaque = false; ctx.respectScreenScale = true
  const r = (size - line) / 2, c = size / 2
  ctx.setStrokeColor(TRACK); ctx.setLineWidth(line); ctx.strokeEllipse(new Rect(line / 2, line / 2, size - line, size - line))
  if (soc !== null && soc > 0) {
    const pts = [], n = Math.max(2, Math.round(soc * 1.2))
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (2 * Math.PI * Math.min(soc, 100)) / 100 * (i / n); pts.push(new Point(c + r * Math.cos(a), c + r * Math.sin(a))) }
    const p = new Path(); p.addLines(pts); ctx.addPath(p); ctx.setStrokeColor(socColor(soc)); ctx.setLineWidth(line); ctx.strokePath()
    for (const q of [pts[0], pts[pts.length - 1]]) { ctx.setFillColor(socColor(soc)); ctx.fillEllipse(new Rect(q.x - line / 2, q.y - line / 2, line, line)) }
  }
  ctx.setFont(Font.boldRoundedSystemFont(size * 0.26)); ctx.setTextColor(soc === null ? TRACK : socColor(soc)); ctx.setTextAlignedCenter()
  const t = soc === null ? '—' : `${soc}%`, fh = size * 0.32
  ctx.drawTextInRect(t, new Rect(0, c - fh / 2, size, fh))
  return ctx.getImage()
}
function bar(soc, w, h) {
  const ctx = new DrawContext(); ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true
  const p = new Path(); p.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2); ctx.addPath(p); ctx.setFillColor(TRACK); ctx.fillPath()
  if (soc) { const f = new Path(); f.addRoundedRect(new Rect(0, 0, Math.max(h, (w * Math.min(soc, 100)) / 100), h), h / 2, h / 2); ctx.addPath(f); ctx.setFillColor(socColor(soc)); ctx.fillPath() }
  return ctx.getImage()
}
function txt(stack, s, size, color, weight = 'regular') {
  const t = stack.addText(s)
  t.font = weight === 'bold' ? Font.boldRoundedSystemFont(size) : weight === 'semi' ? Font.semiboldRoundedSystemFont(size) : Font.regularRoundedSystemFont(size)
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6
  return t
}
function icon(stack, name, size, color) {
  const sym = SFSymbol.named(name); if (!sym) return
  sym.applyFont(Font.semiboldSystemFont(size)); const i = stack.addImage(sym.image); i.imageSize = new Size(size, size); i.tintColor = color
}
function glass(parent, T, radius = 16) {
  const s = parent.addStack(); s.backgroundColor = T.card; s.cornerRadius = radius; s.borderWidth = 1; s.borderColor = T.edge
  return s
}
function lightPill(w, T, d, size) {
  const on = d.light?.on, p = glass(w, T, 99); p.setPadding(5, 10, 5, 12); p.centerAlignContent()
  icon(p, on ? 'bolt.fill' : 'bolt.slash.fill', size, on ? GREEN : RED); p.addSpacer(5)
  txt(p, lightText(d.light, Date.now()), size, T.text, 'semi')
}

// ---------- розміри ----------
function small(w, T, d, s) {
  const top = w.addStack(); top.centerAlignContent()
  txt(top, s.name, 14, T.text, 'bold'); top.addSpacer()
  icon(top, d.light?.on ? 'bolt.fill' : 'bolt.slash.fill', 13, d.light?.on ? GREEN : RED)
  w.addSpacer()
  const mid = w.addStack(); mid.addSpacer(); mid.addImage(ring(s.soc, 84, 9)).imageSize = new Size(84, 84); mid.addSpacer()
  w.addSpacer()
  const st = w.addStack(); st.centerAlignContent(); st.addSpacer()
  icon(st, stateIcon(s), 11, T.dim); st.addSpacer(4); txt(st, stateText(s), 12, T.dim, 'semi'); st.addSpacer()
}

function medium(w, T, d) {
  const head = w.addStack(); head.centerAlignContent(); lightPill(head, T, d, 12); head.addSpacer(); txt(head, clock(d.at), 10, T.dim)
  w.addSpacer(8)
  const row = w.addStack(); row.spacing = 8
  for (const s of d.stations) {
    const c = glass(row, T, 18); c.layoutVertically(); c.setPadding(8, 6, 8, 6);
    const n = c.addStack(); n.addSpacer(); txt(n, s.name, 12, T.text, 'bold'); n.addSpacer()
    c.addSpacer(4)
    const r = c.addStack(); r.addSpacer(); r.addImage(ring(s.soc, 50, 6)).imageSize = new Size(50, 50); r.addSpacer()
    c.addSpacer(4)
    const st = c.addStack(); st.addSpacer(); txt(st, stateText(s), 10, T.dim, 'semi'); st.addSpacer()
  }
}

function large(w, T, d) {
  const head = w.addStack(); head.centerAlignContent(); lightPill(head, T, d, 14); head.addSpacer(); txt(head, `оновлено ${clock(d.at)}`, 10, T.dim)
  w.addSpacer(10)
  for (const s of d.stations) {
    const c = glass(w, T, 22); c.setPadding(10, 14, 10, 14); c.centerAlignContent(); c.size = new Size(0, 96)
    c.addImage(ring(s.soc, 66, 7)).imageSize = new Size(66, 66); c.addSpacer(14)
    const col = c.addStack(); col.layoutVertically()
    txt(col, s.name, 17, T.text, 'bold'); col.addSpacer(4)
    const st = col.addStack(); st.centerAlignContent(); icon(st, stateIcon(s), 13, T.dim); st.addSpacer(5); txt(st, stateText(s), 14, T.dim, 'semi')
    col.addSpacer(3); const l = col.addStack(); l.centerAlignContent(); icon(l, 'bolt.horizontal.fill', 13, T.dim); l.addSpacer(5)
    txt(l, s.loadW !== null && !s.staleAt ? `${s.loadW} Вт` : '— Вт', 14, T.dim, 'semi')
    c.addSpacer()
    w.addSpacer(10)
  }
  w.addSpacer()
}

// ---------- дані ----------
async function key() {
  if (Keychain.contains(KC)) return Keychain.get(KC)
  if (config.runsInWidget) return null
  const a = new Alert(); a.title = 'EcoFlow'; a.message = 'Встав WIDGET_TOKEN (той самий, що в GitHub Secrets)'
  a.addSecureTextField('ключ', ''); a.addAction('Зберегти'); a.addCancelAction('Скасувати')
  if ((await a.presentAlert()) === -1) return null
  const k = a.textFieldValue(0).trim(); if (k) Keychain.set(KC, k); return k || null
}
async function load(k) {
  const req = new Request(`${URL}?key=${encodeURIComponent(k)}`); req.timeoutInterval = 45
  const d = await req.loadJSON()
  if (req.response?.statusCode === 403) { if (!config.runsInWidget) Keychain.remove(KC); throw new Error('невірний ключ') }
  return withCache(d)
}
// River 3 по MQTT інколи не встигає надіслати пакет за час запиту — тоді показуємо останні дані
// з кешу на телефоні (до 2 год) з позначкою «дані о HH:MM». Cloudflare це нічого не коштує.
function withCache(d) {
  const fm = FileManager.local(), path = fm.joinPath(fm.cacheDirectory(), 'ecoflow-widget.json')
  let cache = {}
  try { if (fm.fileExists(path)) cache = JSON.parse(fm.readString(path)) } catch {}
  for (const s of d.stations) {
    const c = cache[s.cmd]
    if (s.soc !== null) cache[s.cmd] = { soc: s.soc, remMin: s.remMin, fromGrid: s.fromGrid, loadW: s.loadW, at: d.at }
    else if (c && d.at - c.at < 2 * 3600 * 1000) Object.assign(s, { soc: c.soc, remMin: c.remMin, fromGrid: c.fromGrid, loadW: c.loadW, staleAt: c.at })
  }
  try { fm.writeString(path, JSON.stringify(cache)) } catch {}
  return d
}
// ---------- «прозорий» фон: шматок скріншота шпалер під місцем віджета ----------
// Геометрія віджетів у пікселях скріншота: ліві x колонок, верхні y рядів, розміри.
// 1290×2796 виміряно зі скріншотів (iPhone Pro Max / Plus, iOS 26). Інші екрани — приблизно, масштабом.
const GEO = {
  '1290x2796': { x: [92, 681], y: [252, 892, 1532], s: [524, 524], m: [1113, 524], l: [1113, 1164] },
}
const FMG = FileManager.local()
const BG_DIR = FMG.joinPath(FMG.documentsDirectory(), 'ecoflow-bg')
function geoFor(w, h) {
  const g = GEO[`${w}x${h}`]
  if (g) return { g, exact: true }
  const k = w / 1290, b = GEO['1290x2796'], sc = (a) => a.map((v) => Math.round(v * k))
  return { g: { x: sc(b.x), y: b.y.map((v) => Math.round((v / 2796) * h)), s: sc(b.s), m: sc(b.m), l: sc(b.l) }, exact: false }
}
const SLOTS = [
  ...['top', 'mid', 'bottom'].flatMap((r, ri) => ['left', 'right'].map((c, ci) => ({ id: `small-${r}-${c}`, size: 's', ri, ci }))),
  ...['top', 'mid', 'bottom'].map((r, ri) => ({ id: `medium-${r}`, size: 'm', ri, ci: 0 })),
  ...['top', 'mid'].map((r, ri) => ({ id: `large-${r}`, size: 'l', ri, ci: 0 })),
]
async function setupBg() {
  const a = new Alert(); a.title = 'Прозорий фон'
  a.message = 'Зроби скріншот ПОРОЖНЬОЇ сторінки домашнього екрана: довге натискання на екран → гортай праворуч до порожньої сторінки → скріншот. Потім вибери його тут.'
  a.addAction('Вибрати скріншот'); a.addCancelAction('Скасувати')
  if ((await a.presentAlert()) === -1) return
  const img = await Photos.fromLibrary()
  const W = img.size.width, H = img.size.height
  const { g, exact } = geoFor(W, H)
  if (!FMG.fileExists(BG_DIR)) FMG.createDirectory(BG_DIR, true)
  for (const sl of SLOTS) {
    const [sw, sh] = g[sl.size], x = sl.size === 's' ? g.x[sl.ci] : g.x[0], y = g.y[sl.ri]
    if (y + sh > H) continue
    const ctx = new DrawContext(); ctx.size = new Size(sw, sh); ctx.respectScreenScale = false
    ctx.drawImageAtPoint(img, new Point(-x, -y))
    FMG.writeImage(FMG.joinPath(BG_DIR, `${sl.id}.png`), ctx.getImage())
  }
  const d = new Alert(); d.title = 'Готово'
  d.message = (exact ? '' : `Екран ${W}×${H} ще не виміряний — позиції приблизні. Надішли скрін домашнього екрана з віджетом, щоб додати точні.\n\n`) +
    'У Parameter віджета вкажи його місце: ряд top / mid / bottom і для маленького left / right. Наприклад: «marinka top left», «mid» для великого посередині.'
  d.addAction('OK'); await d.present()
}
function resetBg() { if (FMG.fileExists(BG_DIR)) FMG.remove(BG_DIR) }
function bgImage(fam, toks, dark) {
  if (toks.includes('solid') || !['small', 'medium', 'large'].includes(fam)) return null
  const row = toks.find((t) => ['top', 'mid', 'bottom'].includes(t)) ?? 'top'
  const col = toks.find((t) => ['left', 'right'].includes(t)) ?? 'left'
  const id = fam === 'small' ? `small-${row}-${col}` : `${fam}-${row}`
  const path = FMG.joinPath(BG_DIR, `${id}.png`)
  if (!FMG.fileExists(path)) return null
  const img = FMG.readImage(path)
  const ctx = new DrawContext(); ctx.size = img.size; ctx.respectScreenScale = false
  ctx.drawImageAtPoint(img, new Point(0, 0))
  ctx.setFillColor(dark ? hex('#000000', 0.32) : hex('#ffffff', 0.35)); ctx.fillRect(new Rect(0, 0, img.size.width, img.size.height))
  return ctx.getImage()
}

function parseParam(stations) {
  const toks = (args.widgetParameter || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)
  const theme = toks.find((t) => THEMES[t]) ?? 'auto'
  let st = stations[0]
  for (const t of toks) {
    const i = Number(t)
    const hit = Number.isInteger(i) && i >= 1 ? stations[i - 1] : stations.find((s) => s.cmd === t || s.name.toLowerCase() === t || s.name.toLowerCase().startsWith(t))
    if (hit) { st = hit; break }
  }
  return { theme, st, toks }
}

async function main(famOverride) {
  const fam = famOverride ?? config.widgetFamily ?? 'medium'
  const w = new ListWidget(); w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000)
  const acc = fam.startsWith('accessory')
  const preTheme = THEMES[(args.widgetParameter || '').toLowerCase().split(/[\s,;]+/).find((t) => THEMES[t]) ?? 'auto']
  let d
  try {
    const k = await key(); if (!k) throw new Error('немає ключа — відкрий скрипт у Scriptable')
    d = await load(k)
  } catch (e) {
    if (acc) { w.addText('EcoFlow —') ; return w }
    const g = new LinearGradient(); g.colors = preTheme.bg; g.locations = [0, 1]; w.backgroundGradient = g
    txt(w, 'EcoFlow', 14, preTheme.text, 'bold'); w.addSpacer(4); txt(w, 'Немає даних', 13, RED, 'semi')
    const m = w.addText(String(e.message || e).slice(0, 90)); m.font = Font.systemFont(10); m.textColor = preTheme.dim
    return w
  }
  const { theme, st, toks } = parseParam(d.stations)
  // на «прозорому» фоні auto = темне скло: шпалери затемнюються, текст білий
  const bg = bgImage(fam, toks, theme !== 'light')
  const T = THEMES[bg && theme === 'auto' ? 'glass' : theme]
  if (fam === 'accessoryInline') {
    w.addText(`${d.light?.on ? '⚡' : '⛔'} ${st.name} ${st.soc ?? '—'}%`)
  } else if (fam === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true
    const s = w.addStack(); s.layoutVertically(); s.addSpacer()
    const a = s.addStack(); a.addSpacer(); icon(a, d.light?.on ? 'bolt.fill' : 'bolt.slash.fill', 11, Color.white()); a.addSpacer()
    const b = s.addStack(); b.addSpacer(); const t = b.addText(`${st.soc ?? '—'}`); t.font = Font.boldRoundedSystemFont(18); b.addSpacer()
    const c = s.addStack(); c.addSpacer(); const n = c.addText(st.name.slice(0, 6)); n.font = Font.systemFont(8); c.addSpacer()
    s.addSpacer()
  } else if (fam === 'accessoryRectangular') {
    const h = w.addStack(); h.centerAlignContent(); icon(h, d.light?.on ? 'bolt.fill' : 'bolt.slash.fill', 11, Color.white()); h.addSpacer(3)
    const t = h.addText(lightText(d.light, Date.now())); t.font = Font.boldRoundedSystemFont(12)
    for (const s of d.stations) { const r = w.addText(`${s.name} ${s.soc ?? '—'}% · ${stateText(s)}`); r.font = Font.regularRoundedSystemFont(11); r.lineLimit = 1 }
  } else {
    if (bg) w.backgroundImage = bg
    else { const g = new LinearGradient(); g.colors = T.bg; g.locations = [0, 1]; w.backgroundGradient = g }
    if (fam === 'small') { w.setPadding(14, 14, 12, 14); small(w, T, d, st) }
    else if (fam === 'medium') { w.setPadding(12, 12, 12, 12); medium(w, T, d) }
    else { w.setPadding(16, 16, 16, 16); large(w, T, d) }
  }
  return w
}

if (config.runsInWidget) Script.setWidget(await main())
else {
  // У застосунку: прев'ю та налаштування фону
  const a = new Alert(); a.title = 'EcoFlow'
  ;['Прев\'ю: маленький', 'Прев\'ю: середній', 'Прев\'ю: великий', 'Прозорий фон: налаштувати', 'Прозорий фон: вимкнути'].forEach((x) => a.addAction(x))
  a.addCancelAction('Закрити')
  const i = await a.presentSheet()
  if (i >= 0 && i <= 2) { const p = await main(['small', 'medium', 'large'][i]); await [p.presentSmall, p.presentMedium, p.presentLarge][i].call(p) }
  else if (i === 3) await setupBg()
  else if (i === 4) resetBg()
}
Script.complete()
