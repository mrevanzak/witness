// Client for one computer's control server, on Effect HttpClient. Responses are
// decoded with the shared protocol schemas.
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Computer } from "./computer.ts"
import { ControlError } from "./computer.ts"
import {
	type ActRequest,
	ConsoleMessage,
	ErrorBody,
	EvaluateResult,
	type ExecRequest,
	ExecResult,
	Health,
	LogsResult,
	NavigateResult,
	NetworkEvent,
	PageSnapshot,
	RecordingResult,
	RecordStartResult,
	type Screenshot,
	ShotHeaders,
	type ShotOptions,
} from "./protocol.ts"

type ControlCalls = Omit<Computer, "id" | "runId" | "network" | "control" | "liveView" | "putArchive" | "startService">

export const makeControlClient = Effect.fnUntraced(function* (baseUrl: string, token: string) {
	const client = (yield* HttpClient.HttpClient).pipe(
		HttpClient.mapRequest((r) => r.pipe(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.bearerToken(token)))
	)

	const fail = (method: string, path: string) => (e: { readonly message: string }) =>
		new ControlError({ message: e.message, method, path, remoteTag: null, status: null })

	/** Sends a request; turns non-2xx responses into ControlError with the server's error tag. */
	const send = (method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000) =>
		Effect.gen(function* () {
			let req = method === "GET" ? HttpClientRequest.get(path) : HttpClientRequest.post(path)
			if (method === "POST") {
				req = yield* HttpClientRequest.bodyJson(req, body ?? {}).pipe(Effect.mapError(fail(method, path)))
			}
			const res = yield* client
				.execute(req)
				.pipe(Effect.timeout(`${timeoutMs} millis`), Effect.mapError(fail(method, path)))
			if (res.status >= 200 && res.status < 300) {
				return res
			}
			const err = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(res).pipe(Effect.option)
			return yield* new ControlError({
				message: Option.match(err, { onNone: () => `HTTP ${res.status}`, onSome: (b) => b.error }),
				method,
				path,
				remoteTag: Option.match(err, { onNone: () => null, onSome: (b) => b.tag ?? null }),
				status: res.status,
			})
		})

	const json = <A, I>(
		schema: Schema.Codec<A, I>,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		timeoutMs?: number
	) =>
		send(method, path, body, timeoutMs).pipe(
			Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
			Effect.mapError((e) => (e._tag === "ControlError" ? e : fail(method, path)(e)))
		)

	const shot = (path: string, body: unknown, timeoutMs?: number) =>
		Effect.gen(function* () {
			const res = yield* send("POST", path, body, timeoutMs)
			const data = yield* res.arrayBuffer.pipe(Effect.mapError(fail("POST", path)))
			const h = res.headers
			const actionAt = h[ShotHeaders.actionAt]
			return {
				actionAt: actionAt === undefined ? undefined : Number(actionAt),
				at: Number(h[ShotHeaders.at]),
				cursor: { x: Number(h[ShotHeaders.cursorX]), y: Number(h[ShotHeaders.cursorY]) },
				data: new Uint8Array(data),
				height: Number(h[ShotHeaders.height]),
				mime: h["content-type"] === "image/jpeg" ? "image/jpeg" : "image/png",
				width: Number(h[ShotHeaders.width]),
			} satisfies Screenshot
		})

	const calls: ControlCalls = {
		act: (request: ActRequest) =>
			shot("/act", request, request.action.type === "wait" ? request.action.ms + 30_000 : 60_000),
		consoleMessages: json(Schema.Struct({ messages: Schema.Array(ConsoleMessage) }), "POST", "/browser/console").pipe(
			Effect.map((r) => r.messages)
		),
		evaluate: (expression: string) =>
			json(EvaluateResult, "POST", "/browser/evaluate", { expression }).pipe(Effect.map((r) => r.value)),
		exec: (request: ExecRequest) => json(ExecResult, "POST", "/exec", request, (request.timeout_ms ?? 30_000) + 10_000),
		health: json(Health, "GET", "/health", undefined, 3000),
		logs: (file: string, tail = 200) =>
			json(LogsResult, "GET", `/logs?${new URLSearchParams({ file, tail: String(tail) })}`).pipe(
				Effect.map((r) => r.lines),
				Effect.catchIf(
					(e) => e.status === 404,
					() => Effect.succeed("")
				)
			),
		navigate: (url: string, timeoutMs = 30_000) =>
			json(NavigateResult, "POST", "/browser/navigate", { timeout_ms: timeoutMs, url }, timeoutMs + 10_000),
		networkEvents: json(Schema.Struct({ requests: Schema.Array(NetworkEvent) }), "POST", "/browser/network").pipe(
			Effect.map((r) => r.requests)
		),
		pageSnapshot: (maxText?: number) =>
			json(PageSnapshot, "POST", "/browser/snapshot", maxText === undefined ? {} : { max_text: maxText }),
		screenshot: (options: ShotOptions = {}) => shot("/screenshot", options),
		startRecording: (path?: string) =>
			json(RecordStartResult, "POST", "/record/start", path === undefined ? {} : { path }),
		stopRecording: json(RecordingResult, "POST", "/record/stop", {}, 120_000),
	}
	return calls
})
