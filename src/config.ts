// ════════════════════════════════════════════════════════════════
//  Налаштування під ваші станції — редагуйте лише цей файл.
// ════════════════════════════════════════════════════════════════

export type Device = {
	sn: string // серійний номер (видно в tools/check-api.mjs або в застосунку EcoFlow)
	name: string // як підписувати в повідомленнях
	via: 'rest' | 'mqtt' // 'rest' — якщо check-api показує code 0; 'mqtt' — якщо code 1006
	cmd: string // команда бота латиницею, напр. 'kate' → /kate
}

export const DEVICES: Device[] = [
	{ sn: 'D3M1ZE1A9H990005', name: 'Маринка', via: 'rest', cmd: 'marinka' },
	{ sn: 'R655ZEBAXH170579', name: 'Kate', via: 'mqtt', cmd: 'kate' },
	{ sn: 'R655ZEBAXH171200', name: 'Router', via: 'mqtt', cmd: 'router' },
]

// Станція, по якій визначаємо світло: краще та, що має постійне навантаження (роутер)
export const GRID_SOURCE = 'R655ZEBAXH171200'

export const THRESHOLDS = [50, 25, 10] // %, сповіщення при розряді
export const RESET_GAP = 10 // поріг знову активний, коли заряд піднявся на стільки % вище
export const OFFLINE_ALERT_MIN = 30 // хв без зв'язку → попередження

export const TIMEZONE = 'Europe/Kyiv'
export const QUIET_FROM = 0 // тихий режим: повідомлення без звуку (крім найнижчого порогу)
export const QUIET_TO = 8

// EU-акаунти: api-e.ecoflow.com; US/інші: api.ecoflow.com
export const API = 'https://api-e.ecoflow.com'
export const MQTT_WAIT_MS = 15_000 // River 3 шле BMS-пакет кожні ~10 с
