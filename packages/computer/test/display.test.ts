import { describe, expect, it } from "@effect/vitest"
import { parseCursor, toXdo } from "../src/server/display.ts"

describe("toXdo", () => {
	it("moves and clicks in one invocation, clamped to the screen", () => {
		expect(toXdo({ type: "move", x: -5, y: 2000 })).toEqual(["mousemove", "0", "1079"])
		expect(toXdo({ type: "click", x: 10.4, y: 20.6 })).toEqual(["mousemove", "10", "21", "click", "1"])
		expect(toXdo({ button: "middle", type: "click", x: 1, y: 2 })).toEqual(["mousemove", "1", "2", "click", "2"])
		expect(toXdo({ type: "right_click", x: 1, y: 2 })).toEqual(["mousemove", "1", "2", "click", "3"])
		expect(toXdo({ type: "double_click", x: 1, y: 2 })).toEqual([
			"mousemove",
			"1",
			"2",
			"click",
			"--repeat",
			"2",
			"--delay",
			"80",
			"1",
		])
	})

	it("drags through 15 intermediate points, one 16 ms frame apart", () => {
		const argv = toXdo({ to_x: 250, to_y: 100, type: "drag", x: 100, y: 100 })
		expect(argv.slice(0, 5)).toEqual(["mousemove", "100", "100", "mousedown", "1"])
		expect(argv.slice(-2)).toEqual(["mouseup", "1"])
		const moves = argv.slice(5, -2)
		expect(moves).toHaveLength(15 * 5)
		for (let i = 1; i <= 15; i++) {
			expect(moves.slice((i - 1) * 5, i * 5)).toEqual(["mousemove", String(100 + 10 * i), "100", "sleep", "0.016"])
		}
	})

	it("types and presses keys as the final command", () => {
		expect(toXdo({ text: "-hi there", type: "type" })).toEqual(["type", "--delay", "18", "--", "-hi there"])
		expect(toXdo({ delay_ms: 5, text: "x", type: "type" })).toEqual(["type", "--delay", "5", "--", "x"])
		expect(toXdo({ combo: "ctrl+a  Return", type: "key" })).toEqual([
			"key",
			"--clearmodifiers",
			"--",
			"ctrl+a",
			"Return",
		])
	})

	it("scrolls vertically then horizontally, optionally moving first", () => {
		expect(toXdo({ dy: 3, type: "scroll" })).toEqual(["click", "--repeat", "3", "--delay", "30", "5"])
		expect(toXdo({ dx: -2, dy: -80, type: "scroll", x: 5, y: 6 })).toEqual([
			"mousemove",
			"5",
			"6",
			"click",
			"--repeat",
			"50",
			"--delay",
			"30",
			"4",
			"click",
			"--repeat",
			"2",
			"--delay",
			"30",
			"6",
		])
		expect(toXdo({ type: "scroll" })).toEqual([])
	})
})

describe("parseCursor", () => {
	it("reads X and Y from --shell output", () => {
		expect(parseCursor("X=640\nY=360\nSCREEN=0\nWINDOW=4194311")).toEqual({ x: 640, y: 360 })
	})

	it("fails rather than defaulting to the origin", () => {
		expect(parseCursor("")).toBeUndefined()
		expect(parseCursor("X=640\nSCREEN=0")).toBeUndefined()
	})
})
