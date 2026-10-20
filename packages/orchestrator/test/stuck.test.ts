import { describe, expect, it } from "vitest"
import { actionSignature, StuckDetector } from "../src/stuck.ts"

describe("StuckDetector", () => {
	it("fires on the third identical action with an unchanged screen", () => {
		const d = new StuckDetector(3)
		expect(d.observe("click:1", "h")).toBe(false)
		expect(d.observe("click:1", "h")).toBe(false)
		expect(d.observe("click:1", "h")).toBe(true)
	})
	it("resets when the screen or action changes", () => {
		const d = new StuckDetector(3)
		d.observe("a", "h")
		d.observe("a", "h")
		expect(d.observe("a", "h2")).toBe(false)
		expect(d.observe("b", "h2")).toBe(false)
	})
	it("ignores labels and key order in signatures", () => {
		expect(actionSignature("click", { label: "one", x: 1, y: 2 })).toBe(
			actionSignature("click", { label: "two", x: 1, y: 2 })
		)
		expect(actionSignature("click", { x: 1, y: 2 })).not.toBe(actionSignature("click", { x: 1, y: 3 }))
	})
})
