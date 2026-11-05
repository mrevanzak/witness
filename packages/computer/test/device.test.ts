import { assert, describe, it } from "@effect/vitest"
import { gestureFor } from "../src/device/gestures.ts"
import { parseScreenTree } from "../src/device/screen-tree.ts"
import { pickSimulator } from "../src/device-provider.ts"

const SCREEN = { height: 2000, width: 1000 }

const DESCRIBE = `Source: ax-service
Mode: flat
Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels.

ROOT  AXGroup (0.000, 0.000, 1.000, 1.000)

  AXGroup "The Masjid App" id="card:com.example"  (0.000, 0.000, 1.000, 1.000)
  AXStaticText "Open in “The App”?"  (0.177, 0.469, 0.647, 0.023)
  AXGroup "Vertical scroll bar, 2 pages" value="0%"  (0.816, 0.444, 0.075, 0.053)
  AXButton "Cancel"  (0.142, 0.515, 0.348, 0.055)
  AXButton "Say \\"hi\\""  (0.510, 0.515, 0.348, 0.055)
  AXTextField value="London"  (0.040, 0.083, 0.900, 0.037)
  AXTextField  (0.040, 0.200, 0.080, 0.037)
  AXTextField "home" id="house.fill"  (0.244, 0.916, 0.083, 0.032)`

describe("parseScreenTree", () => {
	it("turns describe lines into elements in screen pixels, without the app card or scroll bars", () => {
		const { elements, text } = parseScreenTree(DESCRIBE, SCREEN)
		assert.deepStrictEqual(
			elements.map((e) => [e.ref, e.tag, e.name, e.value]),
			[
				["e1", "AXStaticText", "Open in “The App”?", undefined],
				["e2", "AXButton", "Cancel", undefined],
				["e3", "AXButton", 'Say "hi"', undefined],
				["e4", "AXTextField", "", "London"],
				["e5", "AXTextField", "home", undefined],
			]
		)
		// Centre of (0.142, 0.515, 0.348, 0.055) on 1000x2000.
		assert.deepStrictEqual([elements[1]?.x, elements[1]?.y, elements[1]?.w, elements[1]?.h], [316, 1085, 348, 110])
		assert.strictEqual(text, "Open in “The App”?")
	})
})

describe("gestureFor", () => {
	it("taps at the fraction of the screen", () => {
		assert.deepStrictEqual(gestureFor({ type: "click", x: 250, y: 500 }, SCREEN), {
			args: { x: 0.25, y: 0.25 },
			tool: "gesture-tap",
		})
	})
	it("scrolls down by swiping up, around the pointer, never past the screen", () => {
		const g = gestureFor({ dy: 5, type: "scroll", x: 500, y: 1000 }, SCREEN)
		assert.deepStrictEqual(g, {
			args: { durationMs: 400, fromX: 0.5, fromY: 0.7, momentum: false, toX: 0.5, toY: 0.3 },
			tool: "gesture-swipe",
		})
		const far = gestureFor({ dy: -50, type: "scroll" }, SCREEN)
		assert.deepStrictEqual(far && "args" in far ? [far.args.fromY, far.args.toY] : [], [0.15, 0.85])
	})
	it("maps desktop key names and refuses keys a phone lacks", () => {
		assert.deepStrictEqual(gestureFor({ combo: "Return", type: "key" }, SCREEN), {
			args: { key: "enter" },
			tool: "keyboard",
		})
		assert.deepStrictEqual(gestureFor({ combo: "home", type: "key" }, SCREEN), {
			args: { button: "home" },
			tool: "button",
		})
		const ctrl = gestureFor({ combo: "ctrl+a", type: "key" }, SCREEN)
		assert.isTrue(ctrl !== undefined && "unsupported" in ctrl)
	})
	it("does nothing for a pointer move", () => {
		assert.isUndefined(gestureFor({ type: "move", x: 1, y: 1 }, SCREEN))
	})
})

describe("pickSimulator", () => {
	const types = [
		{ identifier: "t.ipad", name: "iPad Pro", productFamily: "iPad" },
		{ identifier: "t.16", name: "iPhone 16", productFamily: "iPhone" },
		{ identifier: "t.17", name: "iPhone 17 Pro", productFamily: "iPhone" },
	]
	const runtimes = [
		{
			identifier: "r.26.5",
			isAvailable: true,
			name: "iOS 26.5",
			platform: "iOS",
			supportedDeviceTypes: types,
			version: "26.5",
		},
		{
			identifier: "r.26.10",
			isAvailable: true,
			name: "iOS 26.10",
			platform: "iOS",
			supportedDeviceTypes: types,
			version: "26.10",
		},
		{
			identifier: "r.27",
			isAvailable: false,
			name: "iOS 27.0",
			platform: "iOS",
			supportedDeviceTypes: types,
			version: "27.0",
		},
		{
			identifier: "r.tv",
			isAvailable: true,
			name: "tvOS 26.5",
			platform: "tvOS",
			supportedDeviceTypes: [],
			version: "26.5",
		},
	]
	it("defaults to the newest available iOS and its last iPhone", () => {
		assert.deepStrictEqual(pickSimulator(runtimes, {}), { runtime: "r.26.10", type: "t.17" })
	})
	it("takes a runtime and device type by name", () => {
		assert.deepStrictEqual(pickSimulator(runtimes, { runtime: "iOS 26.5", type: "iPhone 16" }), {
			runtime: "r.26.5",
			type: "t.16",
		})
	})
	it("says what is installed when the wanted runtime is not", () => {
		assert.match(String(pickSimulator(runtimes, { runtime: "iOS 27.0" })), /installed: iOS 26.5, iOS 26.10/)
	})
})
