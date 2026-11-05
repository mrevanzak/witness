// A device screen as the tester reads it: argent's `describe` text (one element
// per line, frames as 0-1 fractions of the screen) turned into page elements in
// screen pixels, the same shape the desktop's page snapshot has.
import type { PageElement, PageSnapshot } from "../protocol.ts"

const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`
const LINE = new RegExp(
	String.raw`^\s*(AX\w+)(?: ${QUOTED})?(?: value=${QUOTED})?(?: id=${QUOTED})?(.*?)\s*\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$`
)
const unquote = (s: string | undefined) => (s === undefined ? undefined : s.replace(/\\(.)/g, "$1"))

/** Scroll indicators: on every scrollable screen, never something to act on. */
const NOISE = /scroll bar/i

/** Roles a person reads rather than taps. */
const TEXT_ROLES = new Set(["AXStaticText", "AXHeading"])

/** Parses argent `describe` text into elements (centres and sizes in screen pixels) and the screen's text. */
export const parseScreenTree = (
	description: string,
	screen: { readonly width: number; readonly height: number },
	maxText = 8000
): Pick<PageSnapshot, "elements" | "text"> => {
	const elements: PageElement[] = []
	const text: string[] = []
	for (const line of description.split("\n")) {
		if (line.startsWith("ROOT")) {
			continue
		}
		const m = LINE.exec(line)
		if (!m) {
			continue
		}
		const [, role = "", rawName, rawValue, rawId, flags = "", fx, fy, fw, fh] = m
		const name = unquote(rawName) ?? ""
		const value = unquote(rawValue)
		const [x, y, w, h] = [fx, fy, fw, fh].map(Number) as [number, number, number, number]
		// The full-screen app card and empty frames are not elements.
		if ((w >= 0.99 && h >= 0.99) || w === 0 || h === 0 || NOISE.test(name)) {
			continue
		}
		if (TEXT_ROLES.has(role) && name) {
			text.push(name)
		}
		if (!(name || value || rawId)) {
			continue
		}
		elements.push({
			h: Math.round(h * screen.height),
			name: name || unquote(rawId) || "",
			ref: `e${elements.length + 1}`,
			role: role.replace(/^AX/, "").toLowerCase(),
			tag: role,
			w: Math.round(w * screen.width),
			x: Math.round((x + w / 2) * screen.width),
			y: Math.round((y + h / 2) * screen.height),
			...(value === undefined ? {} : { value }),
			...(/\bdisabled\b/i.test(flags) ? { disabled: true } : {}),
		})
	}
	return { elements, text: text.join("\n").slice(0, maxText) }
}
