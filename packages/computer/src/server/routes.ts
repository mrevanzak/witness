// Handlers of ControlApi. Every endpoint but /health needs the bearer token.
import { createHash, timingSafeEqual } from "node:crypto"
import { Config, Effect, Layer, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { messageOf } from "../message.ts"
import {
	ControlApi,
	ControlAuth,
	DISPLAY,
	NotReadyError,
	type Screenshot,
	ServerError,
	UnauthorizedError,
} from "../protocol.ts"
import { Artifacts } from "./artifacts.ts"
import { Browser } from "./browser.ts"
import { Display } from "./display.ts"
import { Exec } from "./exec.ts"
import { Recorder } from "./recorder.ts"

export const ControlAuthLive = Layer.effect(
	ControlAuth,
	Effect.gen(function* () {
		// Compared as SHA-256 digests in constant time: equal lengths, and nothing to learn from timing.
		const digest = (s: string) => createHash("sha256").update(s).digest()
		const token = digest(Redacted.value(yield* Config.Redacted("CONTROL_TOKEN")))
		return ControlAuth.of({
			bearer: (httpEffect, { credential }) =>
				timingSafeEqual(digest(Redacted.value(credential)), token)
					? httpEffect
					: Effect.fail(new UnauthorizedError({ message: "unauthorized" })),
		})
	})
)

export const StatusHandlers = HttpApiBuilder.group(
	ControlApi,
	"status",
	Effect.fn(function* (handlers) {
		const display = yield* Display
		const recorder = yield* Recorder
		const browser = yield* Browser
		return handlers.handle("health", () =>
			Effect.gen(function* () {
				const [up, recording, connected] = yield* Effect.all([display.healthy, recorder.recording, browser.connected])
				if (!up) {
					return yield* new NotReadyError({ message: `display ${DISPLAY} is not up` })
				}
				return { browser: connected, recording }
			})
		)
	})
)

export const ControlHandlers = HttpApiBuilder.group(
	ControlApi,
	"control",
	Effect.fn(function* (handlers) {
		const artifacts = yield* Artifacts
		const browser = yield* Browser
		const display = yield* Display
		const exec = yield* Exec
		const recorder = yield* Recorder

		/** A screenshot with the cursor position and the time it was taken. */
		const withCursor = (
			shot: Effect.Effect<Pick<Screenshot, "data" | "height" | "mime" | "width">, ServerError>,
			actionAt?: number
		) =>
			Effect.all([shot, display.cursor], { concurrency: 2 }).pipe(
				Effect.map(([s, cursor]): Screenshot => ({ ...s, actionAt, at: Date.now(), cursor }))
			)

		return handlers.handleAll({
			act: Effect.fn(function* ({ payload }) {
				const at = Date.now()
				yield* display.act(payload.action)
				if (payload.action.type !== "wait") {
					yield* Effect.sleep(`${payload.settle_ms ?? 300} millis`)
				}
				return yield* withCursor(display.screenshot(payload.shot ?? {}), at)
			}),
			console: () => browser.drainConsole,
			evaluate: ({ payload }) =>
				browser.evaluate(payload.expression).pipe(
					Effect.flatMap((value) =>
						Effect.try({
							catch: (e) => new ServerError({ message: `evaluate: ${messageOf(e)}` }),
							// As JSON (dates become strings); `undefined` has no JSON, so it stays absent.
							try: () => (value === undefined ? {} : { value: JSON.parse(JSON.stringify(value)) as unknown }),
						})
					)
				),
			exec: ({ payload }) => exec.run(payload),
			logs: ({ query }) => artifacts.tail(query.file, Math.max(1, Math.min(5000, Math.round(query.tail)))),
			navigate: ({ payload }) => browser.navigate(payload.url, payload.timeout_ms ?? 30_000),
			network: () => browser.drainNetwork,
			screenshot: ({ payload }) => withCursor(display.screenshot(payload)),
			snapshot: ({ payload }) => browser.snapshot(payload.max_text ?? 6000),
			spawn: ({ payload }) => exec.spawn(payload),
			startRecording: () => recorder.start,
			stopRecording: () => recorder.stop,
		})
	})
)
