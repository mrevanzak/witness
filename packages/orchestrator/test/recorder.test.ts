import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Computer, Screenshot } from "@witness/computer"
import { Criterion, parseWitnessConfig } from "@witness/domain"
import { Effect, Layer, Option } from "effect"
import { CurrentRun } from "../src/current-run.ts"
import { describeScreen, makeRecorder, type RecorderApi, shotSpace, ToolCall } from "../src/recorder.ts"
import { runLayer } from "../src/verifier.ts"

const PASSWORD = "hunter22"
const shot = (): Screenshot => ({
	actionAt: undefined,
	at: Date.now(),
	cursor: { x: 0, y: 0 },
	data: new Uint8Array([1, 2, 3]),
	height: 720,
	mime: "image/png",
	width: 1280,
})

// Only what the recorder calls; nothing else of the computer is reached.
const fakeComputer = (navigated: string[]) =>
	({
		act: () => Effect.succeed(shot()),
		consoleMessages: Effect.succeed([]),
		evaluate: () => Effect.succeed({ token: PASSWORD }),
		kind: "desktop",
		logs: () => Effect.succeed(`started with ${PASSWORD}`),
		navigate: (url: string) =>
			Effect.sync(() => {
				navigated.push(url)
				return { at: Date.now(), status: 200, url }
			}),
		networkEvents: Effect.succeed([]),
		pageSnapshot: () =>
			Effect.succeed({ elements: [], text: `password: ${PASSWORD}`, title: "t", url: "http://app:3000/" }),
		screen: { height: 1080, width: 1920 },
		screenshot: () => Effect.succeed(shot()),
	}) as unknown as Computer

const C1 = new Criterion({ description: "d", id: "C1", kind: "feature" })
const C2 = new Criterion({ description: "r", id: "C2", kind: "regression" })

const WEB_APP = `start: x\nurl: http://app:3000\nlogin: { email: qa@example.com, password: ${PASSWORD} }\nservices: { db: { image: postgres } }`
const DEVICE_APP =
	"start: x\nurl: myapp://home\nhealth: http://localhost:8081/status\ndevice: { platform: ios, app: /tmp/My.app }"

/** A recorder over a fake computer, in a fresh run dir. */
const recording = <A, E>(
	f: (r: RecorderApi, ctx: { dir: string; navigated: string[] }) => Effect.Effect<A, E>,
	yaml = WEB_APP
) => {
	const dir = mkdtempSync(join(tmpdir(), "witness-recorder-"))
	const navigated: string[] = []
	return Effect.gen(function* () {
		const config = yield* parseWitnessConfig(yaml)
		yield* CurrentRun.use((run) => run.addSecrets([PASSWORD]))
		const r = yield* makeRecorder(fakeComputer(navigated), config, [C1, C2], 1280)
		return yield* f(r, { dir: join(dir, "run"), navigated })
	}).pipe(Effect.provide(runLayer(dir, "run").pipe(Layer.provideMerge(NodeServices.layer))))
}

const label = "Do it"

describe("Recorder", () => {
	it.effect("keeps navigation on the app, its localhost and its services", () =>
		recording((r, { navigated }) =>
			Effect.gen(function* () {
				const refused = yield* Effect.flip(r.perform(ToolCall.Navigate({ label, url: "https://evil.example/" })))
				assert.include(refused.message, "Only the app under test")
				const deepLink = yield* Effect.flip(r.perform(ToolCall.Navigate({ label, url: "myapp://home" })))
				assert.include(deepLink.message, "Only the app under test")
				yield* r.perform(ToolCall.Navigate({ label, url: "/todos" }))
				yield* r.perform(ToolCall.Navigate({ label, url: "http://db:5432/" }))
				assert.deepStrictEqual(navigated, ["http://app:3000/todos", "http://db:5432/"])
			})
		)
	)

	it.effect("lets a device app open links in its own scheme, and nothing else outside its hosts", () =>
		recording(
			(r, { navigated }) =>
				Effect.gen(function* () {
					for (const url of ["otherapp://home", "https://evil.example/"]) {
						const refused = yield* Effect.flip(r.perform(ToolCall.Navigate({ label, url })))
						assert.include(refused.message, "Only the app under test")
					}
					yield* r.perform(ToolCall.Navigate({ label, url: "myapp://todos/1" }))
					yield* r.perform(ToolCall.Navigate({ label, url: "http://localhost:8081/status" }))
					assert.deepStrictEqual(navigated, ["myapp://todos/1", "http://localhost:8081/status"])
				}),
			DEVICE_APP
		)
	)

	it.effect("never lets the password into a label or typed text, and masks it in what the tester reads", () =>
		recording((r) =>
			Effect.gen(function* () {
				yield* Effect.flip(r.perform(ToolCall.Click({ button: "click", label: `type ${PASSWORD}`, x: 1, y: 1 })))
				yield* Effect.flip(r.perform(ToolCall.Type({ label, text: PASSWORD })))
				yield* r.perform(ToolCall.TypeSecret({ label }))
				for (const call of [
					ToolCall.Snapshot({ maxText: 100 }),
					ToolCall.AppLogs({ file: "app.log", tail: 10 }),
					ToolCall.Evaluate({ expression: "x" }),
				]) {
					const out = yield* r.perform(call)
					assert.notInclude(out.text, PASSWORD)
				}
			})
		)
	)

	it.effect("checks one declared criterion at a time, each once", () =>
		recording((r) =>
			Effect.gen(function* () {
				assert.include((yield* Effect.flip(r.perform(ToolCall.Begin({ id: "C9" })))).message, "Unknown criterion")
				assert.include(
					(yield* Effect.flip(r.perform(ToolCall.End({ forced: Option.none(), id: "C1", notes: "", status: "pass" }))))
						.message,
					"Begin C1 first"
				)
				yield* r.perform(ToolCall.Begin({ id: "C1" }))
				assert.include((yield* Effect.flip(r.perform(ToolCall.Begin({ id: "C2" })))).message, "End C1 first")
				const ended = yield* r.perform(ToolCall.End({ forced: Option.none(), id: "C1", notes: "ok", status: "pass" }))
				assert.strictEqual(ended.text, "Ended C1. Remaining: C2.")
				assert.include((yield* Effect.flip(r.perform(ToolCall.Begin({ id: "C1" })))).message, "already ended")
			})
		)
	)

	it.effect("ends what was never finished blocked, with a screenshot", () =>
		recording((r, { dir }) =>
			Effect.gen(function* () {
				yield* r.perform(ToolCall.Begin({ id: "C1" }))
				const done = yield* r.finish("wall_time", "stopped")
				assert.deepStrictEqual(
					done.records.map((x) => [x.criterion.id, x.status, x.forced, x.screenshot]),
					[
						["C1", "blocked", "wall_time", "c1-blocked.png"],
						["C2", "blocked", "wall_time", "c2-blocked.png"],
					]
				)
				assert.includeMembers(readdirSync(dir), ["c1-blocked.png", "c2-blocked.png", "steps.jsonl"])
			})
		)
	)
})

describe("shotSpace", () => {
	it("keeps a desktop at 1280x720 and stands a phone upright at 1280 high", () => {
		const desktop = shotSpace({ height: 1080, width: 1920 }, 1280)
		assert.deepStrictEqual([desktop.width, desktop.height, desktop.toScreen(640)], [1280, 720, 960])
		const phone = shotSpace({ height: 2622, width: 1206 }, 1280)
		assert.deepStrictEqual([phone.width, phone.height], [589, 1280])
		assert.strictEqual(phone.toScreen(640), 1311)
	})
})

describe("describeScreen", () => {
	it("names the screen and the screenshot pixels coordinates are in", () => {
		const desktop = { height: 1080, width: 1920 }
		assert.include(
			describeScreen({ kind: "desktop", screen: desktop }, shotSpace(desktop, 1280)),
			"a 1920x1080 Linux desktop"
		)
		const phone = { height: 2622, width: 1206 }
		const text = describeScreen({ kind: "phone", screen: phone }, shotSpace(phone, 1280))
		assert.include(text, "a 1206x2622 phone screen")
		assert.include(text, "scaled to 589x1280")
	})
})
