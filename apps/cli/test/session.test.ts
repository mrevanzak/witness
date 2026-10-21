import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BlockedVerdict, Criterion, RUN_FILES } from "@witness/domain"
import { Recorder, type RecorderApi, type ToolCall } from "@witness/orchestrator"
import { Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { act, sessionHost } from "../src/session.ts"

/** A recorder that answers every call with its tag, and remembers the calls. */
const stubRecorder = (runDir: string, calls: ToolCall[]) =>
	({
		perform: (call: ToolCall) =>
			Effect.sync(() => {
				calls.push(call)
				return { screen: Option.none(), text: call._tag }
			}),
		runDir,
	}) as unknown as RecorderApi

const Env = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)

describe("session", () => {
	it.live("serves `witness act` to the side that is up, and reports the verdict once it finishes", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const runDir = mkdtempSync(join(tmpdir(), "witness-session-"))
			const calls: ToolCall[] = []
			const host = yield* sessionHost(runDir, 60_000)
			const side = yield* host
				.program({
					carried: [new Criterion({ description: "d", id: "C1", kind: "feature" })],
					sha: "abc1234",
					state: Option.none(),
				})
				.pipe(Effect.provideService(Recorder, stubRecorder(runDir, calls)), Effect.forkChild)
			const opts = { label: Option.some("Open the form"), run: Option.some(runDir), runsDir: runDir }

			// The side registers as soon as its program starts; act waits for no one.
			yield* Effect.sleep("50 millis")
			assert.strictEqual(yield* act({ ...opts, action: "begin", args: ["C1"] }), 0)
			assert.strictEqual(yield* act({ ...opts, action: "click", args: ["10", "20"] }), 0)
			assert.strictEqual(yield* act({ ...opts, action: "end", args: ["C1"] }), 4) // no status, no notes
			assert.deepStrictEqual(
				calls.map((c) => c._tag),
				["Begin", "Click"]
			)
			assert.deepStrictEqual(calls[1], { _tag: "Click", button: "click", label: "Open the form", x: 10, y: 20 })

			// `finish` ends the side; once the run is over the client prints its verdict and exits with it.
			yield* fs.writeFileString(
				join(runDir, RUN_FILES.verdict),
				Schema.encodeSync(Schema.fromJsonString(BlockedVerdict))(
					new BlockedVerdict({ notes: "n", overall: "blocked", reason: "r" })
				)
			)
			const finishing = yield* act({ ...opts, action: "finish", args: [] }).pipe(Effect.forkChild)
			yield* Fiber.join(side)
			yield* host.finished
			assert.strictEqual(yield* Fiber.join(finishing), 2)
		}).pipe(Effect.scoped, Effect.provide(Env))
	)

	it.live("refuses a command while no side is up", () =>
		Effect.gen(function* () {
			const runDir = mkdtempSync(join(tmpdir(), "witness-session-"))
			yield* sessionHost(runDir, 60_000)
			const code = yield* act({
				action: "shot",
				args: [],
				label: Option.none(),
				run: Option.some(runDir),
				runsDir: runDir,
			})
			assert.strictEqual(code, 4)
		}).pipe(Effect.scoped, Effect.provide(Env))
	)

	it.live("makes `act` name its run when several sessions are open", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"))
			for (const id of ["a", "b"]) {
				yield* fs.makeDirectory(join(runsDir, id))
				yield* fs.writeFileString(join(runsDir, id, RUN_FILES.driver), "{}")
			}
			const error = yield* act({ action: "shot", args: [], label: Option.none(), run: Option.none(), runsDir }).pipe(
				Effect.flip
			)
			assert.include(error.message, "2 sessions are open")
		}).pipe(Effect.provide(Env))
	)
})
