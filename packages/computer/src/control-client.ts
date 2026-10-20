// Client for one computer's control server: the HttpApi client of ControlApi with
// the run's base URL and bearer token, per-call timeouts, and every failure
// folded into ControlError.
import { type Duration, Effect, flow } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { ControlError } from "./computer.ts"
import { messageOf } from "./message.ts"
import {
	type ActRequest,
	type ConsoleMessage,
	ControlApi,
	type ExecRequest,
	type ExecResult,
	type Health,
	type NavigateResult,
	type NetworkEvent,
	type PageSnapshot,
	type RecordingResult,
	type RecordStartResult,
	type Screenshot,
	type ShotOptions,
	type SpawnRequest,
	type SpawnResult,
} from "./protocol.ts"

export type ControlClient = {
	act: (request: ActRequest) => Effect.Effect<Screenshot, ControlError>
	/** Console messages and page errors since the last call. */
	readonly consoleMessages: Effect.Effect<readonly ConsoleMessage[], ControlError>
	/** Evaluates an expression in the visible tab. For walkthroughs, never exposed to the model. */
	evaluate: (expression: string) => Effect.Effect<unknown, ControlError>
	/** Runs a shell command to completion (timeout + output cap). */
	exec: (request: ExecRequest) => Effect.Effect<ExecResult, ControlError>
	readonly health: Effect.Effect<Health, ControlError>
	/** Last `tail` lines of a file under /artifacts; empty when it does not exist. */
	logs: (file: string, tail?: number) => Effect.Effect<string, ControlError>
	navigate: (url: string, timeoutMs?: number) => Effect.Effect<NavigateResult, ControlError>
	/** Failed requests and >= 400 responses since the last call. */
	readonly networkEvents: Effect.Effect<readonly NetworkEvent[], ControlError>
	pageSnapshot: (maxText?: number) => Effect.Effect<PageSnapshot, ControlError>
	screenshot: (options?: ShotOptions) => Effect.Effect<Screenshot, ControlError>
	/** Starts a detached command that lives until the computer stops. */
	spawn: (request: SpawnRequest) => Effect.Effect<SpawnResult, ControlError>
	/** Starts recording the screen to /artifacts/raw.mkv. */
	readonly startRecording: Effect.Effect<RecordStartResult, ControlError>
	/** Finalises raw.mkv and remuxes it to raw.mp4. */
	readonly stopRecording: Effect.Effect<RecordingResult, ControlError>
}

export const makeControlClient = Effect.fnUntraced(function* (baseUrl: string, token: string) {
	const client = yield* HttpApiClient.make(ControlApi, {
		transformClient: HttpClient.mapRequest(
			flow(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.bearerToken(token))
		),
	})

	/** Bounds a call and folds every failure into ControlError. */
	const call =
		(endpoint: string, timeout: Duration.Input = "60 seconds") =>
		<A, E>(effect: Effect.Effect<A, E>) =>
			effect.pipe(
				Effect.timeout(timeout),
				Effect.mapError((e) => new ControlError({ endpoint, message: messageOf(e) }))
			)

	const calls: ControlClient = {
		act: (request) =>
			client.control
				.act({ payload: request })
				.pipe(call("act", request.action.type === "wait" ? `${request.action.ms + 30_000} millis` : undefined)),
		consoleMessages: client.control.console().pipe(call("console")),
		evaluate: (expression) =>
			client.control.evaluate({ payload: { expression } }).pipe(
				Effect.map((r) => r.value),
				call("evaluate")
			),
		exec: (request) =>
			client.control.exec({ payload: request }).pipe(call("exec", `${(request.timeout_ms ?? 30_000) + 10_000} millis`)),
		health: client.status.health().pipe(call("health", "3 seconds")),
		logs: (file, tail = 200) =>
			client.control.logs({ query: { file, tail } }).pipe(
				Effect.catchTag("ArtifactNotFoundError", () => Effect.succeed("")),
				call("logs")
			),
		navigate: (url, timeoutMs = 30_000) =>
			client.control
				.navigate({ payload: { timeout_ms: timeoutMs, url } })
				.pipe(call("navigate", `${timeoutMs + 10_000} millis`)),
		networkEvents: client.control.network().pipe(call("network")),
		pageSnapshot: (maxText) =>
			client.control.snapshot({ payload: maxText === undefined ? {} : { max_text: maxText } }).pipe(call("snapshot")),
		screenshot: (options = {}) => client.control.screenshot({ payload: options }).pipe(call("screenshot")),
		spawn: (request) => client.control.spawn({ payload: request }).pipe(call("spawn")),
		startRecording: client.control.startRecording().pipe(call("startRecording")),
		stopRecording: client.control.stopRecording().pipe(call("stopRecording", "120 seconds")),
	}
	return calls
})
