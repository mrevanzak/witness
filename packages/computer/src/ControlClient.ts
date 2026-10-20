// Client for one computer's control server, on Effect HttpClient. Responses are
// decoded with the shared protocol schemas.
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Computer } from "./Computer.ts"
import { ControlError } from "./Computer.ts"
import {
	ErrorBody,
	EvaluateResult,
	ExecResult,
	Health,
	LogsResult,
	NavigateResult,
	NetworkEvent,
	ConsoleMessage,
	PageSnapshot,
	RecordStartResult,
	RecordingResult,
	ShotHeaders,
	type ActRequest,
	type ExecRequest,
	type Screenshot,
	type ShotOptions,
} from "./protocol.ts"

type ControlCalls = Omit<Computer, "id" | "runId" | "network" | "control" | "liveView" | "putArchive" | "startService">

export const makeControlClient = Effect.fnUntraced(function* (baseUrl: string, token: string) {
	const client = (yield* HttpClient.HttpClient).pipe(
		HttpClient.mapRequest((r) => r.pipe(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.bearerToken(token)))
	)

	const fail = (method: string, path: string) => (e: { readonly message: string }) =>
		new ControlError({ method, path, status: null, remoteTag: null, message: e.message })

	/** Sends a request; turns non-2xx responses into ControlError with the server's error tag. */
	const send = (method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000) =>
		Effect.gen(function* () {
			let req = method === "GET" ? HttpClientRequest.get(path) : HttpClientRequest.post(path)
			if (method === "POST") req = yield* HttpClientRequest.bodyJson(req, body ?? {}).pipe(Effect.mapError(fail(method, path)))
			const res = yield* client.execute(req).pipe(Effect.timeout(`${timeoutMs} millis`), Effect.mapError(fail(method, path)))
			if (res.status >= 200 && res.status < 300) return res
			const err = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(res).pipe(Effect.option)
			return yield* new ControlError({
				method,
				path,
				status: res.status,
				remoteTag: Option.match(err, { onNone: () => null, onSome: (b) => b.tag ?? null }),
				message: Option.match(err, { onNone: () => `HTTP ${res.status}`, onSome: (b) => b.error }),
			})
		})

	const json = <A, I>(schema: Schema.Codec<A, I>, method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number) =>
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
				data: new Uint8Array(data),
				mime: h["content-type"] === "image/jpeg" ? "image/jpeg" : "image/png",
				width: Number(h[ShotHeaders.width]),
				height: Number(h[ShotHeaders.height]),
				cursor: { x: Number(h[ShotHeaders.cursorX]), y: Number(h[ShotHeaders.cursorY]) },
				at: Number(h[ShotHeaders.at]),
				actionAt: actionAt === undefined ? undefined : Number(actionAt),
			} satisfies Screenshot
		})

	const calls: ControlCalls = {
		health: json(Health, "GET", "/health", undefined, 3000),
		screenshot: (options: ShotOptions = {}) => shot("/screenshot", options),
		act: (request: ActRequest) => shot("/act", request, request.action.type === "wait" ? request.action.ms + 30_000 : 60_000),
		exec: (request: ExecRequest) => json(ExecResult, "POST", "/exec", request, (request.timeout_ms ?? 30_000) + 10_000),
		startRecording: (path?: string) => json(RecordStartResult, "POST", "/record/start", path === undefined ? {} : { path }),
		stopRecording: json(RecordingResult, "POST", "/record/stop", {}, 120_000),
		navigate: (url: string, timeoutMs = 30_000) => json(NavigateResult, "POST", "/browser/navigate", { url, timeout_ms: timeoutMs }, timeoutMs + 10_000),
		pageSnapshot: (maxText?: number) => json(PageSnapshot, "POST", "/browser/snapshot", maxText === undefined ? {} : { max_text: maxText }),
		evaluate: (expression: string) => json(EvaluateResult, "POST", "/browser/evaluate", { expression }).pipe(Effect.map((r) => r.value)),
		consoleMessages: json(Schema.Struct({ messages: Schema.Array(ConsoleMessage) }), "POST", "/browser/console").pipe(Effect.map((r) => r.messages)),
		networkEvents: json(Schema.Struct({ requests: Schema.Array(NetworkEvent) }), "POST", "/browser/network").pipe(Effect.map((r) => r.requests)),
		logs: (file: string, tail = 200) =>
			json(LogsResult, "GET", `/logs?${new URLSearchParams({ file, tail: String(tail) })}`).pipe(
				Effect.map((r) => r.lines),
				Effect.catchIf((e) => e.status === 404, () => Effect.succeed(""))
			),
	}
	return calls
})
