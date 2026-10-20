// The control client against the real handlers over HTTP (a web handler behind
// fetch), with the server's services faked.
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Ref } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { makeControlClient } from "../src/control-client.ts"
import { ArtifactNotFoundError, ControlApi, RecordingStateError } from "../src/protocol.ts"
import { Artifacts } from "../src/server/artifacts.ts"
import { Browser } from "../src/server/browser.ts"
import { Display } from "../src/server/display.ts"
import { Exec } from "../src/server/exec.ts"
import { Recorder } from "../src/server/recorder.ts"
import { ControlAuthLive, ControlHandlers, StatusHandlers } from "../src/server/routes.ts"

const IMAGE = new Uint8Array([137, 80, 78, 71])

const fakes = (displayUp: boolean, recording: Ref.Ref<boolean>) =>
	Layer.mergeAll(
		Layer.succeed(
			Display,
			Display.of({
				act: () => Effect.void,
				cursor: Effect.succeed({ x: 12, y: 34 }),
				healthy: Effect.succeed(displayUp),
				screenshot: (o) =>
					Effect.succeed({
						data: IMAGE,
						height: o.width ? Math.round((1080 * o.width) / 1920) : 1080,
						mime: o.format === "jpeg" ? "image/jpeg" : "image/png",
						width: o.width ?? 1920,
					}),
			})
		),
		Layer.succeed(
			Browser,
			Browser.of({
				connected: Effect.succeed(true),
				drainConsole: Effect.succeed([{ at: 1, text: "hi", type: "log", url: "about:blank" }]),
				drainNetwork: Effect.succeed([]),
				evaluate: (e) => Effect.succeed(e === "undefined" ? undefined : { e }),
				navigate: (url) => Effect.succeed({ at: 1, status: 200, url }),
				snapshot: () =>
					Effect.succeed({ elements: [], text: "", title: "", url: "", viewport: { h: 1, w: 1, x: 0, y: 0 } }),
			})
		),
		Layer.succeed(
			Exec,
			Exec.of({
				run: (r) => Effect.succeed({ code: 0, stderr: "", stdout: r.cmd, timed_out: false, truncated: false }),
				spawn: () => Effect.succeed({ pid: 42 }),
			})
		),
		Layer.succeed(
			Recorder,
			Recorder.of({
				recording: Ref.get(recording),
				start: Ref.getAndSet(recording, true).pipe(
					Effect.flatMap((was) =>
						was
							? Effect.fail(new RecordingStateError({ message: "already recording" }))
							: Effect.succeed({ mkv: "/artifacts/raw.mkv", startedAt: 5 })
					)
				),
				stop: Effect.succeed({ duration: 1, mkv: "/artifacts/raw.mkv", mp4: "/artifacts/raw.mp4", t0: null }),
			})
		),
		Layer.succeed(
			Artifacts,
			Artifacts.of({
				resolve: (p) => Effect.succeed(`/artifacts/${p}`),
				tail: (p, lines) =>
					p === "app.log"
						? Effect.succeed(`last ${lines}`)
						: Effect.fail(new ArtifactNotFoundError({ message: `no such file: ${p}`, path: p })),
			})
		)
	)

const client = (opts: { readonly token?: string; readonly displayUp?: boolean } = {}) =>
	Effect.gen(function* () {
		const recording = yield* Ref.make(false)
		const routes = HttpApiBuilder.layer(ControlApi).pipe(
			Layer.provide([StatusHandlers, ControlHandlers]),
			Layer.provide(ControlAuthLive),
			Layer.provide(fakes(opts.displayUp ?? true, recording)),
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CONTROL_TOKEN: "secret" }))),
			Layer.provide(HttpServer.layerServices)
		)
		const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
		yield* Effect.addFinalizer(() => Effect.promise(dispose))
		return yield* makeControlClient("http://computer", opts.token ?? "secret").pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, (input, init) => handler(new Request(input, init)))
		)
	})

describe("control API", () => {
	it.effect("returns screenshots with their metadata from headers", () =>
		Effect.gen(function* () {
			const c = yield* client()
			const png = yield* c.screenshot()
			assert.deepStrictEqual(
				{ ...png, at: 0, data: [...png.data] },
				{
					actionAt: undefined,
					at: 0,
					cursor: { x: 12, y: 34 },
					data: [...IMAGE],
					height: 1080,
					mime: "image/png",
					width: 1920,
				}
			)
			assert.isAbove(png.at, 0)
			const jpeg = yield* c.act({
				action: { type: "click", x: 1, y: 2 },
				settle_ms: 0,
				shot: { format: "jpeg", width: 960 },
			})
			assert.strictEqual(jpeg.mime, "image/jpeg")
			assert.strictEqual(jpeg.height, 540)
			assert.isNumber(jpeg.actionAt)
		}).pipe(Effect.scoped)
	)

	it.effect("decodes JSON and text endpoints", () =>
		Effect.gen(function* () {
			const c = yield* client()
			assert.deepStrictEqual(yield* c.health, { browser: true, recording: false })
			assert.strictEqual((yield* c.exec({ cmd: "echo" })).stdout, "echo")
			assert.deepStrictEqual(yield* c.spawn({ cmd: "sleep 1", log: "app.log" }), { pid: 42 })
			assert.deepStrictEqual(yield* c.evaluate("1"), { e: "1" })
			assert.isUndefined(yield* c.evaluate("undefined"))
			assert.strictEqual((yield* c.consoleMessages).length, 1)
			assert.strictEqual(yield* c.logs("app.log", 7), "last 7")
			assert.strictEqual(yield* c.logs("missing.log"), "")
			assert.strictEqual((yield* c.startRecording).mkv, "/artifacts/raw.mkv")
			assert.deepStrictEqual(yield* c.health, { browser: true, recording: true })
			const again = yield* Effect.flip(c.startRecording)
			assert.strictEqual(again.endpoint, "startRecording")
			assert.include(again.message, "already recording")
		}).pipe(Effect.scoped)
	)

	it.effect("rejects a wrong token, but not on /health", () =>
		Effect.gen(function* () {
			const c = yield* client({ token: "wrong" })
			const e = yield* Effect.flip(c.screenshot())
			assert.strictEqual(e._tag, "ControlError")
			assert.include(e.message, "unauthorized")
			assert.isTrue(Option.isSome(yield* Effect.option(c.health)))
		}).pipe(Effect.scoped)
	)

	it.effect("fails health while the display is down", () =>
		Effect.gen(function* () {
			const c = yield* client({ displayUp: false })
			const e = yield* Effect.flip(c.health)
			assert.include(e.message, "not up")
		}).pipe(Effect.scoped)
	)
})
