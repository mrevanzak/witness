import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { retriable } from "../src/device/argent.ts"
import { gestureFor } from "../src/device/gestures.ts"
import { isCredential, waitUntil } from "../src/device/host.ts"
import { parseScreenTree } from "../src/device/screen-tree.ts"
import { pickDeviceType, pickImage, pickSimulator } from "../src/device-provider.ts"

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

const ANDROID = `Source: android-devtools
Mode: nested
Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels.

ROOT  Screen (0.000, 0.000, 1.000, 1.000)

  ComposeView  (0.000, 0.000, 1.000, 1.000)
    StaticText "The Masjid App"  (0.205, 0.083, 0.281, 0.021)
    TextField "http://localhost:8081" [clickable,long-clickable]  (0.136, 0.392, 0.728, 0.052)
    View "Home" [clickable,disabled]  (0.039, 0.909, 0.281, 0.065)
      View "Home"  (0.151, 0.918, 0.058, 0.026)`

describe("parseScreenTree on Android", () => {
	it("reads nested lines, roles without the AX prefix and the disabled flag", () => {
		const { elements, text } = parseScreenTree(ANDROID, SCREEN)
		assert.deepStrictEqual(
			elements.map((e) => [e.tag, e.role, e.name, e.disabled]),
			[
				["StaticText", "statictext", "The Masjid App", undefined],
				["TextField", "textfield", "http://localhost:8081", undefined],
				["View", "view", "Home", true],
				["View", "view", "Home", undefined],
			]
		)
		assert.strictEqual(text, "The Masjid App")
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
		assert.throws(() => pickSimulator(runtimes, { runtime: "iOS 27.0" }), /installed: iOS 26.5, iOS 26.10/)
	})
})

describe("pickImage", () => {
	const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64"
	const image = (api: number, tag: string) => ({ abi, api, path: `system-images;android-${api};${tag};${abi}`, tag })
	const images = [
		image(34, "google_apis"),
		image(35, "google_apis_playstore"),
		image(35, "google_apis"),
		image(36, "android-tv"),
	]
	it("defaults to the newest phone image, Google APIs before Google Play", () => {
		assert.strictEqual(pickImage(images, undefined), `system-images;android-35;google_apis;${abi}`)
	})
	it("takes an API level, or a level and a tag", () => {
		assert.strictEqual(pickImage(images, "android-34"), `system-images;android-34;google_apis;${abi}`)
		assert.strictEqual(
			pickImage(images, "android-35;google_apis_playstore"),
			`system-images;android-35;google_apis_playstore;${abi}`
		)
	})
	it("says what is installed when nothing matches", () => {
		assert.throws(() => pickImage(images, "android-30"), /installed: system-images;android-34/)
	})
})

describe("pickDeviceType", () => {
	it("takes the newest numbered Pixel", () => {
		assert.strictEqual(pickDeviceType(["pixel_6a", "pixel_9", "pixel_10", "pixel_9_pro", "Nexus 5"]), "pixel_10")
	})
})

describe("isCredential", () => {
	it("keeps keys and tokens from the app's commands, and the rest of the environment in", () => {
		for (const name of [
			"ANTHROPIC_API_KEY",
			"GH_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"npm_config_password",
			"GOOGLE_CREDENTIALS",
		]) {
			assert.isTrue(isCredential(name), name)
		}
		for (const name of ["PATH", "HOME", "ANDROID_HOME", "KEYCHAIN_PATH", "TOKENIZERS_PARALLELISM"]) {
			assert.isFalse(isCredential(name), name)
		}
	})
})

describe("retriable", () => {
	it("tries a look again after the device dropped off, never a tap or keystroke", () => {
		assert.isTrue(retriable("describe", "error: device offline"))
		assert.isTrue(retriable("screenshot", "device 'emulator-5560' not found"))
		assert.isFalse(retriable("gesture-tap", "error: device offline"))
		assert.isFalse(retriable("keyboard", "error: device offline"))
		assert.isFalse(retriable("describe", "no such element"))
	})
})

describe("waitUntil", () => {
	it.live("checks until the condition holds", () =>
		Effect.gen(function* () {
			let checks = 0
			const ok = yield* waitUntil(
				Effect.sync(() => {
					checks += 1
					return checks === 3
				}),
				"1 millis",
				"1 second"
			)
			assert.deepStrictEqual([ok, checks], [true, 3])
		})
	)
	it.live("gives up once the time is over", () =>
		Effect.gen(function* () {
			assert.isFalse(yield* waitUntil(Effect.succeed(false), "5 millis", "30 millis"))
		})
	)
})
