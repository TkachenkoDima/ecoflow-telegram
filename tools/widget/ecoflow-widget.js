// Віджет EcoFlow для iPhone (Scriptable).
// Перший запуск ▶︎ у Scriptable: ключ WIDGET_TOKEN (зберігається в Keychain), головна станція, що відкривати по тапу.
// Повторно: ▶︎ → «Налаштування».
// Parameter віджета (необов'язково) — інша головна станція для конкретного віджета: router | kate | marinka (або 1 | 2 | 3).
// Маленький — головна станція; середній і великий — головна крупно, решта поруч.
const URL = 'https://frosty-union-469b.frosty-union-469b.workers.dev/widget'
const KC = 'ecoflow_widget_key'

// ---------- кольори ----------
const hex = (h, a = 1) => new Color(h, a)
const C = {
  bg: hex('#15181d'), text: hex('#f2f4f7'), soft: hex('#e3e7ed'), dim: hex('#9aa3b2'), faint: hex('#8b93a1'),
  outline: hex('#e9edf2'), divider: hex('#2a2f37'), card: hex('#1c2026'), cardEdge: hex('#262b33'),
  on: hex('#7ad7a0'), off: hex('#ff9f43'), err: hex('#ff6b6b'),
  hourOn: '#3c6e55', hourOff: '#c4772f', hourNone: '#262b33', wire: hex('#2f353e'),
}
// заливка батареї за рівнем заряду: [темніший, світліший]
const band = (s) => (s < 15 ? ['#c92a2a', '#ff6b6b'] : s < 30 ? ['#d9480f', '#ff9f43'] : s < 60 ? ['#d4a106', '#ffd43b'] : ['#2b9a5a', '#69db7c'])

// ---------- текст ----------
const pad = (n) => String(n).padStart(2, '0')
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
// тривалість для «вистачить ~…» / «до 100% ~…»
function human(min) {
  // компактно, без пробілу між числом і одиницею: 25хв · 1г 35хв · 10д 23г 59хв
  const m = Math.max(0, Math.round(min)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return [d && `${d}д`, h && `${h}г`, mm && `${mm}хв`].filter(Boolean).join(' ') || '0хв'
}
// тривалість стану світла: довга (2г 10хв, 152д 23г) і коротка (2:10)
function since(ms, short) {
  const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return h ? `${d}д ${h}г` : `${d}д`
  if (short) return `${h}:${pad(mm)}`
  return h ? `${h}г${mm ? ` ${mm}хв` : ''}` : `${mm}хв`
}
const status = (l, now, short) => (!l ? 'СВІТЛО: —' : `${l.on ? 'СВІТЛО Є' : 'БЕЗ СВІТЛА'} · ${now - l.since < 60000 ? 'щойно' : since(now - l.since, short)}`)
const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'відключення' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'відключення' : 'відключень')
// ціль заряду — ліміт станції (toPct), зазвичай 100%
const charging = (s) => (s.inW ?? 0) > 10 && s.fromGrid !== false && (s.soc ?? 100) < (s.toPct ?? 100)
// заголовок над головним рядком (середній і великий віджет)
const head = (s, ch) => (ch ? `ДО ${s.toPct ?? 100}%` : !s.online || s.staleAt || s.soc === null ? 'СТАН' : s.remMin !== null ? 'ВИСТАЧИТЬ НА' : s.fromGrid ? 'ЖИВЛЕННЯ' : 'СТАН')
// два рядки під станцією: головне (вистачить / до 100%) і другорядне (споживання / заряд)
function lines(s) {
  if (s.staleAt) return [`дані о ${clock(s.staleAt)}`, s.loadW !== null ? `споживання ${s.loadW} Вт` : '']
  if (!s.online) return ['офлайн', '']
  if (s.soc === null) return ['немає даних', '']
  const use = s.loadW !== null && s.loadW !== undefined ? `споживання ${s.loadW} Вт` : ''
  if (charging(s)) return [s.fullMin ? `до ${s.toPct ?? 100}% ~${human(s.fullMin)}` : 'заряджається', `${s.other ? 'вхід' : 'заряд'} +${s.inW} Вт`]
  if (s.remMin !== null) return [`вистачить ~${human(s.remMin)}`, use]
  // світла немає, а вхід є — це не мережа (інша станція / сонце)
  if (s.fromGrid) return [s.other ? `вхід +${s.inW ?? 0} Вт` : s.soc >= (s.toPct ?? 100) - 1 ? 'заряджена' : 'від мережі', use]
  // не заряджається й нічого не живить
  if (!s.loadW) return ['без навантаження', '']
  return ['—', use]
}

// ---------- графіка ----------
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const x = p(a), y = p(b)
  return new Color('#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''))
}
// батарейка з градієнтною заливкою за зарядом (w×h — корпус, справа «носик»)
function battery(soc, w, h) {
  const bw = Math.max(1.5, h / 14), nub = Math.max(2, h / 9), ctx = new DrawContext()
  ctx.size = new Size(w + nub + 2, h); ctx.opaque = false; ctx.respectScreenScale = true
  const r = h * 0.26
  const o = new Path(); o.addRoundedRect(new Rect(bw / 2, bw / 2, w - bw, h - bw), r, r); ctx.addPath(o)
  ctx.setStrokeColor(C.outline); ctx.setLineWidth(bw); ctx.strokePath()
  const n = new Path(); n.addRoundedRect(new Rect(w + 1, h * 0.32, nub, h * 0.36), nub / 2, nub / 2); ctx.addPath(n); ctx.setFillColor(C.outline); ctx.fillPath()
  if (soc !== null && soc !== undefined) {
    const ins = bw + Math.max(1.5, h / 11), iw = w - ins * 2, ih = h - ins * 2, fw = Math.max(ih * 0.6, (iw * Math.min(100, Math.max(0, soc))) / 100)
    const [c0, c1] = band(soc), N = 18, fr = r * 0.55
    for (let i = N; i >= 1; i--) {
      const p = new Path(); p.addRoundedRect(new Rect(ins, ins, (fw * i) / N, ih), fr, fr); ctx.addPath(p)
      ctx.setFillColor(mix(c0, c1, i / N)); ctx.fillPath()
    }
  }
  return ctx.getImage()
}
function hoursBar(hours, w, h) {
  const ctx = new DrawContext(); ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true
  const gap = Math.max(1, w / 220), cw = (w - gap * 23) / 24
  ;(hours ?? Array(24).fill(null)).forEach((v, i) => {
    const p = new Path(); p.addRoundedRect(new Rect(i * (cw + gap), 0, cw, h), h / 3.5, h / 3.5); ctx.addPath(p)
    ctx.setFillColor(new Color(v === 1 ? C.hourOn : v === 0 ? C.hourOff : C.hourNone)); ctx.fillPath()
  })
  return ctx.getImage()
}
function txt(stack, s, size, color, weight = 'regular') {
  const t = stack.addText(s)
  t.font = weight === 'heavy' ? (typeof Font.heavyRoundedSystemFont === 'function' ? Font.heavyRoundedSystemFont(size) : Font.boldRoundedSystemFont(size)) : weight === 'bold' ? Font.boldRoundedSystemFont(size) : weight === 'semi' ? Font.semiboldRoundedSystemFont(size) : Font.regularRoundedSystemFont(size)
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.6
  return t
}
function icon(stack, name, size, color) {
  const sym = SFSymbol.named(name); if (!sym) return
  sym.applyFont(Font.semiboldSystemFont(size)); const i = stack.addImage(sym.image); i.imageSize = new Size(size, size); i.tintColor = color
}
function img(stack, image, w, h) { const i = stack.addImage(image); i.imageSize = new Size(w, h); return i }
const bolt = (stack, on, size) => icon(stack, on ? 'bolt.fill' : 'bolt.slash.fill', size, on ? C.on : C.off)
function wire(stack, color) { const s = stack.addStack(); s.size = new Size(0, 1.5); s.backgroundColor = color; s.addSpacer() }
function hourLabels(stack, size) {
  const r = stack.addStack(); ['00', '06', '12', '18', '24'].forEach((x, i) => { if (i) r.addSpacer(); txt(r, x, size, C.faint) })
}
// назва + маленька батарейка (+ що завгодно справа)
// назва · (блискавка, якщо передано стан світла) · маленька батарейка
// right — батарейка притиснута до правого краю рядка
function nameRow(parent, s, size, bw, lightOn, right = false) {
  const r = parent.addStack(); r.centerAlignContent()
  txt(r, s.name, size, C.text, 'bold'); r.addSpacer(size * 0.4)
  if (lightOn !== undefined) { bolt(r, lightOn, size * 0.85); r.addSpacer(size * 0.4) }
  if (right) r.addSpacer()
  img(r, battery(s.soc, bw, bw / 2), bw + bw / 18 + 2, bw / 2)
  return r
}

// ---------- розміри ----------
function small(w, d, s) {
  // шапка · (простір) · батарейка з % · (простір) · статус і два рядки — вільне місце ділиться порівну
  const top = w.addStack(); top.centerAlignContent(); txt(top, s.name, 17, C.text, 'bold'); top.addSpacer(6); bolt(top, d.light?.on, 15); top.addSpacer(); txt(top, clock(d.at), 10, C.faint)
  w.addSpacer()
  const b = w.addStack(); b.centerAlignContent()
  // батарейка фіксованого розміру, а шрифт % підібраний так, щоб «100%» влазило поруч без стискання
  // % — по центру вільного місця праворуч від батарейки
  img(b, battery(s.soc, 50, 28), 50 + 4 + 2, 28); b.addSpacer(4); b.addSpacer()
  txt(b, s.soc === null ? '—' : `${s.soc}%`, 30, C.text, 'heavy'); b.addSpacer()
  w.addSpacer()
  const [l1, l2] = lines(s)
  // час оновлення — у шапці після блискавки: статус («152 д 23 г») і «споживання 120 Вт» займають усю ширину
  txt(w, status(d.light, Date.now(), false), 12, d.light?.on ? C.on : C.off, 'bold')
  // «ще ~10д 23г 59хв» коротше за «вистачить …» — влазить у ширину маленького віджета
  w.addSpacer(3); txt(w, l1.replace('вистачить ', 'ще '), 15, C.soft, 'semi')
  txt(w, l2 || ' ', 12.5, C.dim)
}

function others(d, main) { return d.stations.filter((x) => x.cmd !== main.cmd) }

function medium(w, d, s) {
  const row = w.addStack(); row.spacing = 13
  // ліворуч — головна станція (без смужки годин: текст крупніше)
  const L = row.addStack(); L.layoutVertically(); L.size = new Size(176, 0)
  nameRow(L, s, 18, 26, !!d.light?.on, true)
  L.addSpacer(2); txt(L, s.soc === null ? '—' : `${s.soc}%`, 50, C.text, 'heavy')
  L.addSpacer()
  txt(L, status(d.light, Date.now(), false), 11, d.light?.on ? C.on : C.off, 'bold'); L.addSpacer(4)
  const ch = charging(s), [l1, l2] = lines(s)
  // підпис, значення і другорядне — окремими рядками, щоб нічого не переносилось
  txt(L, head(s, ch), 8.5, C.dim, 'bold')
  txt(L, l1.replace('вистачить ', '').replace(/^до \d+% /, ''), 18, C.text, 'bold')
  if (l2) txt(L, l2, 11, C.dim)
  // роздільник
  const sep = row.addStack(); sep.size = new Size(1, 0); sep.backgroundColor = C.divider; sep.layoutVertically(); sep.addSpacer()
  // праворуч — решта станцій
  const R = row.addStack(); R.layoutVertically()
  const rest = others(d, s)
  rest.forEach((o, i) => {
    if (i) R.addSpacer()
    nameRow(R, o, 12, 21, undefined, true)
    txt(R, o.soc === null ? '—' : `${o.soc}%`, 25, C.text, 'heavy')
    const [a, b] = lines(o); txt(R, a, 10.5, C.soft, 'semi')
    // час оновлення — у правому нижньому куті (в останньому рядку правої колонки)
    if (i === rest.length - 1) { const z = R.addStack(); z.bottomAlignContent(); txt(z, b || ' ', 10, C.dim); z.addSpacer(); z.addSpacer(4); txt(z, clock(d.at), 8, C.faint) }
    else txt(R, b || ' ', 10, C.dim)
  })
}

function large(w, d, s) {
  const h = nameRow(w, s, 15, 26, !!d.light?.on); h.addSpacer(); txt(h, clock(d.at), 8, C.faint)
  w.addSpacer()
  const ch = charging(s), [l1, l2] = lines(s)
  const big = w.addStack(); big.bottomAlignContent()
  txt(big, s.soc === null ? '—' : `${s.soc}%`, 64, C.text, 'heavy'); big.addSpacer()
  const k = big.addStack(); k.layoutVertically()
  const kl = k.addStack(); kl.addSpacer(); txt(kl, head(s, ch), 7.5, C.dim, 'bold')
  const kv = k.addStack(); kv.addSpacer(); txt(kv, l1.replace('вистачить ', '').replace(/^до \d+% /, ''), 19, C.text, 'bold')
  k.addSpacer(5)
  w.addSpacer(4); txt(w, status(d.light, Date.now(), false), 9, d.light?.on ? C.on : C.off, 'bold')
  w.addSpacer(7); img(w, hoursBar(d.day?.hours, 328, 7), 328, 7); w.addSpacer(3); hourLabels(w, 7)
  w.addSpacer()
  // вхід → споживання
  const f = w.addStack(); f.centerAlignContent(); f.spacing = 6
  icon(f, 'powerplug', 17, (s.inW ?? 0) > 1 ? C.on : C.faint)
  txt(f, `${s.inW ?? 0} Вт`, 15, (s.inW ?? 0) > 1 ? C.text : C.faint, 'bold')
  wire(f, (s.inW ?? 0) > 1 ? C.on : C.wire); txt(f, 'СПОЖИВАННЯ', 7, C.dim, 'bold'); wire(f, C.off)
  txt(f, s.loadW !== null && s.loadW !== undefined ? `~${s.loadW} Вт` : '—', 15, C.text, 'bold')
  icon(f, 'house', 17, C.off)
  if (d.day) {
    w.addSpacer(6)
    txt(w, d.day.count ? `сьогодні без світла ${human(d.day.offMin)} · ${d.day.count} ${plural(d.day.count)}` : 'сьогодні без відключень', 9, C.dim)
  }
  w.addSpacer()
  const cards = w.addStack(); cards.spacing = 7
  others(d, s).forEach((o) => {
    const c = cards.addStack(); c.layoutVertically(); c.backgroundColor = C.card; c.cornerRadius = 13; c.borderWidth = 1; c.borderColor = C.cardEdge
    c.setPadding(10, 11, 10, 11)
    const n = nameRow(c, o, 12, 23); n.addSpacer()
    c.addSpacer(2); txt(c, o.soc === null ? '—' : `${o.soc}%`, 29, C.text, 'heavy')
    const [a, b] = lines(o); c.addSpacer(2); txt(c, a, 10, C.soft, 'semi'); txt(c, b || ' ', 9, C.dim)
  })
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
async function load(k, withGroups = false) {
  const req = new Request(`${URL}?key=${encodeURIComponent(k)}${withGroups ? '&groups=1' : ''}`); req.timeoutInterval = 45
  const d = await req.loadJSON()
  if (req.response?.statusCode === 403) { if (!config.runsInWidget) Keychain.remove(KC); throw new Error('невірний ключ') }
  if (!d.stations) throw new Error(d.error ?? 'немає даних')
  return withCache(d)
}
// Якщо станція не відповіла — показуємо останні дані з кешу на телефоні (до 2 год) з позначкою «дані о HH:MM»
function withCache(d) {
  const fm = FileManager.local(), path = fm.joinPath(fm.cacheDirectory(), 'ecoflow-widget.json')
  let cache = {}
  try { if (fm.fileExists(path)) cache = JSON.parse(fm.readString(path)) } catch {}
  const keys = ['soc', 'remMin', 'fromGrid', 'loadW', 'inW', 'fullMin', 'toPct', 'other']
  for (const s of d.stations) {
    const c = cache[s.cmd]
    if (s.soc !== null) cache[s.cmd] = { ...Object.fromEntries(keys.map((x) => [x, s[x] ?? null])), at: d.at }
    else if (c && d.at - c.at < 2 * 3600 * 1000) Object.assign(s, Object.fromEntries(keys.map((x) => [x, c[x] ?? null])), { staleAt: c.at })
  }
  try { fm.writeString(path, JSON.stringify(cache)) } catch {}
  return d
}
// Налаштування — у файлі на телефоні; Parameter віджета може задати іншу станцію
const FMG = FileManager.local()
const SET_PATH = FMG.joinPath(FMG.documentsDirectory(), 'ecoflow-settings.json')
function loadSet() { try { return FMG.fileExists(SET_PATH) ? JSON.parse(FMG.readString(SET_PATH)) : null } catch { return null } }
function saveSet(v) { FMG.writeString(SET_PATH, JSON.stringify(v)) }
function mainStation(stations) {
  const set = loadSet() ?? {}
  const t = (args.widgetParameter || '').trim().toLowerCase()
  const i = Number(t)
  return (t && (Number.isInteger(i) && i >= 1 ? stations[i - 1] : stations.find((s) => s.cmd === t || s.name.toLowerCase().startsWith(t))))
    || stations.find((s) => s.cmd === set.station) || stations[0]
}
async function pick(title, options) {
  const a = new Alert(); a.title = title; options.forEach((o) => a.addAction(o)); a.addCancelAction('Скасувати')
  return a.presentSheet()
}
async function settings() {
  const k = await key(); if (!k) return
  const set = loadSet() ?? {}
  try {
    const d = await load(k, true)
    const s = await pick('Головна станція', d.stations.map((x) => x.name))
    if (s >= 0) set.station = d.stations[s].cmd
    const groups = d.groups ?? []
    if (groups.length) {
      const g = await pick('Тап по віджету відкриває', [...groups.map((x) => `Telegram: ${x.title ?? 'група'}`), 'Scriptable'])
      if (g >= 0) set.chat = g < groups.length ? groups[g].chat : null
    }
  } catch (e) { const a = new Alert(); a.title = 'Не вдалося отримати дані'; a.message = String(e.message || e); a.addAction('OK'); await a.present() }
  saveSet(set)
}

// коли просити iOS оновити віджет: вдень — через 5 хв, уночі (00–07) — через 30 хв, але не пізніше 07:00
// (точний момент вирішує iOS; ніч економить її денний «бюджет» оновлень)
function nextRefresh() {
  const now = new Date(), t = now.getTime()
  if (now.getHours() >= 7) return new Date(t + 5 * 60 * 1000)
  const morning = new Date(now); morning.setHours(7, 0, 0, 0)
  return new Date(Math.min(t + 30 * 60 * 1000, morning.getTime()))
}

async function main(famOverride) {
  const fam = famOverride ?? config.widgetFamily ?? 'medium'
  const w = new ListWidget(); w.refreshAfterDate = nextRefresh()
  const acc = fam.startsWith('accessory')
  if (!acc) w.backgroundColor = C.bg
  let d
  try {
    const k = await key(); if (!k) throw new Error('немає ключа — відкрий скрипт у Scriptable')
    d = await load(k)
  } catch (e) {
    if (acc) { w.addText('EcoFlow —'); return w }
    txt(w, 'EcoFlow', 14, C.text, 'bold'); w.addSpacer(4); txt(w, 'Немає даних', 13, C.err, 'semi')
    const m = w.addText(String(e.message || e).slice(0, 90)); m.font = Font.systemFont(10); m.textColor = C.dim
    return w
  }
  const st = mainStation(d.stations)
  // тап по віджету — у Telegram на закріплений екран вибраної групи
  const tap = (d.groups ?? []).find((g) => g.chat === loadSet()?.chat)?.link
  if (tap) w.url = tap
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
    const t = h.addText(status(d.light, Date.now(), false)); t.font = Font.boldRoundedSystemFont(12)
    for (const s of d.stations) { const r = w.addText(`${s.name} ${s.soc ?? '—'}% · ${lines(s)[0]}`); r.font = Font.regularRoundedSystemFont(11); r.lineLimit = 1 }
  } else if (fam === 'small') { w.setPadding(13, 14, 12, 14); small(w, d, st) }
  else if (fam === 'medium') { w.setPadding(14, 16, 14, 16); medium(w, d, st) }
  else { w.setPadding(16, 18, 16, 18); large(w, d, st) }
  return w
}

if (config.runsInWidget) Script.setWidget(await main())
else {
  // У застосунку: перший запуск — налаштування; далі меню
  if (!loadSet()) await settings()
  else {
    const i = await pick('EcoFlow', ['Налаштування', 'Прев\'ю: маленький', 'Прев\'ю: середній', 'Прев\'ю: великий'])
    if (i === 0) await settings()
    else if (i >= 1) { const p = await main(['small', 'medium', 'large'][i - 1]); await [p.presentSmall, p.presentMedium, p.presentLarge][i - 1].call(p) }
  }
}
Script.complete()
