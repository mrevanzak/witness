// The desktop's mouse-and-keyboard actions as touch gestures on a phone: a click
// is a tap, a right click a long press, a drag a slow swipe, a wheel scroll a
// swipe the other way. Coordinates arrive in screen pixels and leave as the 0-1
// fractions argent takes.
import type { Action } from "../protocol.ts"

/** One argent tool call. */
export type ArgentCall = { readonly tool: string; readonly args: Record<string, unknown> }

/** xdotool key names the desktop tester uses, as argent keyboard keys. */
const KEYS: Record<string, string> = {
	backspace: "backspace",
	down: "arrow-down",
	enter: "enter",
	escape: "escape",
	kp_enter: "enter",
	left: "arrow-left",
	return: "enter",
	right: "arrow-right",
	space: "space",
	tab: "tab",
	up: "arrow-up",
}
/** Hardware buttons, pressed with `key home` and the like. */
const BUTTONS = new Set(["home", "back", "appSwitch"])

/** Screen share one wheel click scrolls; a swipe never travels more than SWIPE_MAX of the screen. */
const WHEEL_STEP = 0.08
const SWIPE_MAX = 0.7

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const round3 = (v: number) => Math.round(v * 1000) / 1000

/** The argent calls for `action` on a screen of `screen` pixels, or a reason it has no touch equivalent. */
export const gestureFor = (
	action: Exclude<Action, { type: "wait" }>,
	screen: { readonly width: number; readonly height: number }
): ArgentCall | { readonly unsupported: string } | undefined => {
	const nx = (v: number) => round3(clamp01(v / screen.width))
	const ny = (v: number) => round3(clamp01(v / screen.height))
	switch (action.type) {
		case "move":
			return undefined
		case "click":
			return { args: { x: nx(action.x), y: ny(action.y) }, tool: "gesture-tap" }
		case "double_click":
			return { args: { clickCount: 2, x: nx(action.x), y: ny(action.y) }, tool: "gesture-tap" }
		case "right_click": {
			const at = { x: nx(action.x), y: ny(action.y) }
			return {
				args: {
					events: [
						{ type: "Down", ...at },
						{ delayMs: 800, type: "Up", ...at },
					],
				},
				tool: "gesture-custom",
			}
		}
		case "drag":
			return {
				args: {
					durationMs: 800,
					fromX: nx(action.x),
					fromY: ny(action.y),
					momentum: false,
					toX: nx(action.to_x),
					toY: ny(action.to_y),
				},
				tool: "gesture-swipe",
			}
		case "scroll": {
			const x = action.x === undefined ? 0.5 : nx(action.x)
			const y = action.y === undefined ? 0.5 : ny(action.y)
			const dy = action.dy ?? 0
			const dx = action.dx ?? 0
			if (!(dy || dx)) {
				return undefined
			}
			// Content moves with the finger, so scrolling down is a swipe up.
			const travel = (n: number) => Math.sign(n) * Math.min(SWIPE_MAX, Math.abs(n) * WHEEL_STEP)
			const tx = travel(dx)
			const ty = travel(dy)
			return {
				args: {
					durationMs: 400,
					fromX: round3(clamp01(x + tx / 2)),
					fromY: round3(clamp01(y + ty / 2)),
					momentum: false,
					toX: round3(clamp01(x - tx / 2)),
					toY: round3(clamp01(y - ty / 2)),
				},
				tool: "gesture-swipe",
			}
		}
		case "type":
			return { args: { text: action.text }, tool: "keyboard" }
		case "key": {
			const combo = action.combo.trim()
			if (BUTTONS.has(combo)) {
				return { args: { button: combo }, tool: "button" }
			}
			const key = KEYS[combo.toLowerCase()]
			return key
				? { args: { key }, tool: "keyboard" }
				: {
						unsupported: `the phone has no key ${JSON.stringify(combo)}; use one of ${[...new Set(Object.values(KEYS)), ...BUTTONS].join(", ")}`,
					}
		}
	}
}
