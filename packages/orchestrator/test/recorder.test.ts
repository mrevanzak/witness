import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Computer, Screenshot } from "@witness/computer"
import { Criterion, parseWitnessConfig } from "@witness/domain"
import { Effect, Layer, Option } from "effect"
import { CurrentRun } from "../src/current-run.ts"
import { makeRecorder, type RecorderApi, ToolCall } from "../src/recorder.ts"
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
		logs: () => Effect.succeed(`started with ${PASSWORD}`),
		navigate: (url: string) =>
			Effect.sync(() => {
				navigated.push(url)
				return { at: Date.now(), status: 200, url }
			}),
		networkEvents: Effect.succeed([]),
		pageSnapshot: () =>
			Effect.succeed({ elements: [], text: `password: ${PASSWORD}`, title: "t", url: "http://app:3000/" }),
		screenshot: () => Effect.succeed(shot()),
	}) as unknown as Computer

const C1 = new Criterion({ description: "d", id: "C1", kind: "feature" })
const C2 = new Criterion({ description: "r", id: "C2", kind: "regression" })

/** A recorder over a fake computer, in a fresh run dir. */
const recording = <A, E>(f: (r: RecorderApi, ctx: { dir: string; navigated: string[] }) => Effect.Effect<A, E>) => {
	const dir = mkdtempSync(join(tmpdir(), "witness-recorder-"))
	const navigated: string[] = []
	return Effect.gen(function* () {
		const config = yield* parseWitnessConfig(
			`start: x\nurl: http://app:3000\nlogin: { email: qa@example.com, password: ${PASSWORD} }\nservices: { db: { image: postgres } }`
		)
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
				yield* r.perform(ToolCall.Navigate({ label, url: "/todos" }))
				yield* r.perform(ToolCall.Navigate({ label, url: "http://db:5432/" }))
				assert.deepStrictEqual(navigated, ["http://app:3000/todos", "http://db:5432/"])
			})
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
