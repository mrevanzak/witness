// HTTP routes of the control server. Every route but /health needs the bearer token.
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
	ActRequest,
	EvaluateRequest,
	ExecRequest,
	NavigateRequest,
	RecordStartRequest,
	ShotHeaders,
	ShotOptions,
} from "../protocol.ts"
import { Artifacts } from "./artifacts.ts"
import { Browser } from "./browser.ts"
import { Display } from "./display.ts"
import { BadRequestError, UnauthorizedError } from "./errors.ts"
import { Exec } from "./exec.ts"
import { Recorder } from "./recorder.ts"

const STATUS: Record<string, number> = {
	UnauthorizedError: 401,
	BadRequestError: 400,
	ArtifactPathError: 400,
	ArtifactNotFoundError: 404,
	RecordingStateError: 409,
}

const body = <A, I>(schema: Schema.Codec<A, I>) =>
	HttpServerRequest.schemaBodyJson(schema).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })))

const LogsQuery = Schema.Struct({
	file: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("app.log"))),
	tail: Schema.NumberFromString.pipe(Schema.withDecodingDefaultKey(Effect.succeed("200"))),
})

export const RoutesLive = Layer.unwrap(
	Effect.gen(function* () {
		const token = yield* Config.Redacted("CONTROL_TOKEN")
		const expected = `Bearer ${Redacted.value(token)}`

		// Auth + error mapping for one route; typed failures become JSON with a status.
		const route = <E extends { readonly _tag: string; readonly message: string }, R>(
			method: "GET" | "POST",
			path: `/${string}`,
			handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
		) =>
			HttpRouter.add(
				method,
				path,
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					if (request.headers.authorization !== expected) return yield* new UnauthorizedError({ message: "unauthorized" })
					return yield* handler
				}).pipe(
					Effect.catch((e) => HttpServerResponse.json({ error: e.message, tag: e._tag }, { status: STATUS[e._tag] ?? 500 })),
					Effect.orDie
				)
			)

		const shotResponse = (shot: Effect.Effect<{ data: Uint8Array; mime: string; width: number; height: number }, { readonly _tag: string; readonly message: string }, Display>, actionAt?: number) =>
			Effect.gen(function* () {
				const display = yield* Display
				const [s, cursor] = yield* Effect.all([shot, display.cursor], { concurrency: 2 })
				return HttpServerResponse.uint8Array(s.data, {
					contentType: s.mime,
					headers: {
						[ShotHeaders.cursorX]: String(cursor.x),
						[ShotHeaders.cursorY]: String(cursor.y),
						[ShotHeaders.at]: String(Date.now()),
						[ShotHeaders.width]: String(s.width),
						[ShotHeaders.height]: String(s.height),
						...(actionAt === undefined ? {} : { [ShotHeaders.actionAt]: String(actionAt) }),
					},
				})
			})

		return Layer.mergeAll(
			HttpRouter.add(
				"GET",
				"/health",
				Effect.gen(function* () {
					const [ok, recording, browser] = yield* Effect.all([Display.use((d) => d.healthy), Recorder.use((r) => r.recording), Browser.use((b) => b.connected)])
					return yield* HttpServerResponse.json({ ok, display: ":1", recording, browser }, { status: ok ? 200 : 503 })
				}).pipe(Effect.orDie)
			),
			route(
				"POST",
				"/screenshot",
				Effect.gen(function* () {
					const options = yield* body(ShotOptions)
					return yield* shotResponse(Display.use((d) => d.screenshot(options)))
				})
			),
			route(
				"POST",
				"/act",
				Effect.gen(function* () {
					const req = yield* body(ActRequest)
					const display = yield* Display
					const at = Date.now()
					yield* display.act(req.action)
					if (req.action.type !== "wait") yield* Effect.sleep(`${req.settle_ms ?? 300} millis`)
					return yield* shotResponse(display.screenshot(req.shot ?? {}), at)
				})
			),
			route(
				"POST",
				"/exec",
				Effect.gen(function* () {
					const req = yield* body(ExecRequest)
					return yield* HttpServerResponse.json(yield* Exec.use((x) => x.run(req)))
				})
			),
			route(
				"POST",
				"/record/start",
				Effect.gen(function* () {
					const req = yield* body(RecordStartRequest)
					return yield* HttpServerResponse.json(yield* Recorder.use((r) => r.start(req.path)))
				})
			),
			route("POST", "/record/stop", Effect.flatMap(Recorder.use((r) => r.stop), (r) => HttpServerResponse.json(r))),
			route(
				"POST",
				"/browser/navigate",
				Effect.gen(function* () {
					const req = yield* body(NavigateRequest)
					return yield* HttpServerResponse.json(yield* Browser.use((b) => b.navigate(req.url, req.timeout_ms ?? 30_000)))
				})
			),
			route(
				"POST",
				"/browser/snapshot",
				Effect.gen(function* () {
					const req = yield* body(Schema.Struct({ max_text: Schema.optionalKey(Schema.Int) }))
					return yield* HttpServerResponse.json(yield* Browser.use((b) => b.snapshot(req.max_text ?? 6000)))
				})
			),
			route(
				"POST",
				"/browser/evaluate",
				Effect.gen(function* () {
					const req = yield* body(EvaluateRequest)
					return yield* HttpServerResponse.json({ value: yield* Browser.use((b) => b.evaluate(req.expression)) })
				})
			),
			route("POST", "/browser/console", Effect.flatMap(Browser.use((b) => b.drainConsole), (messages) => HttpServerResponse.json({ messages }))),
			route("POST", "/browser/network", Effect.flatMap(Browser.use((b) => b.drainNetwork), (requests) => HttpServerResponse.json({ requests }))),
			route(
				"GET",
				"/logs",
				Effect.gen(function* () {
					const q = yield* HttpServerRequest.schemaSearchParams(LogsQuery).pipe(Effect.mapError((e) => new BadRequestError({ message: e.message })))
					const tail = Math.max(1, Math.min(5000, Math.round(q.tail)))
					return yield* HttpServerResponse.json(yield* Artifacts.use((a) => a.tail(q.file, tail)))
				})
			)
		)
	})
)
