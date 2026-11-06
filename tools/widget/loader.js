// EcoFlow — завантажувач віджета для Scriptable. Ставиться на телефон ОДИН раз:
// сам віджет щоразу береться свіжий з GitHub (не частіше разу на годину), без інтернету — остання збережена версія.
const SRC = 'https://raw.githubusercontent.com/TkachenkoDima/ecoflow-telegram/main/tools/widget/ecoflow-widget.js'
const fm = FileManager.local(), path = fm.joinPath(fm.documentsDirectory(), 'ecoflow-widget-code.js')
let code = null
const fresh = fm.fileExists(path) && Date.now() - fm.modificationDate(path).getTime() < 3600 * 1000
if (!fresh || !config.runsInWidget) {
  try {
    const r = new Request(SRC); r.timeoutInterval = 10
    const c = await r.loadString()
    if (r.response.statusCode === 200 && c.includes('Script.complete')) { code = c; fm.writeString(path, c) }
  } catch {}
}
if (!code && fm.fileExists(path)) code = fm.readString(path)
if (!code) throw new Error('Потрібен інтернет для першого завантаження')
await new (Object.getPrototypeOf(async function () {}).constructor)(code)()
