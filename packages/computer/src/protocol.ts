// Wire protocol of the computer's control server: request/response schemas shared
// by the server (in the image) and the client (in the orchestrator).
import { Schema } from "effect"

export const SCREEN_W = 1920
export const SCREEN_H = 1080

const Px = Schema.Finite

export const ShotOptions = Schema.Struct({
	/** Downscale to this width (keeps aspect ratio). Coordinates stay in screen pixels. */
	width: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 160, maximum: SCREEN_W })))),
	format: Schema.optionalKey(Schema.Literals(["png", "jpeg"])),
	quality: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 10, maximum: 100 })))),
})
export type ShotOptions = typeof ShotOptions.Type

export const Action = Schema.Union([
	Schema.Struct({ type: Schema.Literals(["click", "double_click", "right_click", "move"]), x: Px, y: Px, button: Schema.optionalKey(Schema.Literals(["left", "middle"])) }),
	Schema.Struct({ type: Schema.Literal("drag"), x: Px, y: Px, to_x: Px, to_y: Px }),
	Schema.Struct({ type: Schema.Literal("type"), text: Schema.String, delay_ms: Schema.optionalKey(Schema.Int) }),
	Schema.Struct({ type: Schema.Literal("key"), combo: Schema.String.pipe(Schema.check(Schema.isNonEmpty())) }),
	Schema.Struct({ type: Schema.Literal("scroll"), x: Schema.optionalKey(Px), y: Schema.optionalKey(Px), dx: Schema.optionalKey(Schema.Int), dy: Schema.optionalKey(Schema.Int) }),
	Schema.Struct({ type: Schema.Literal("wait"), ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))) }),
])
export type Action = typeof Action.Type

export const ActRequest = Schema.Struct({
	action: Action,
	settle_ms: Schema.optionalKey(Schema.Int),
	shot: Schema.optionalKey(ShotOptions),
})
export type ActRequest = typeof ActRequest.Type

/** Screenshot metadata travels in response headers next to the image bytes. */
export const ShotHeaders = {
	cursorX: "x-cursor-x",
	cursorY: "x-cursor-y",
	at: "x-at",
	actionAt: "x-action-at",
	width: "x-width",
	height: "x-height",
} as const

export interface Screenshot {
	readonly data: Uint8Array
	readonly mime: "image/png" | "image/jpeg"
	readonly width: number
	readonly height: number
	readonly cursor: { readonly x: number; readonly y: number }
	/** Wall-clock ms (computer clock) when the screenshot was taken. */
	readonly at: number
	/** Wall-clock ms when the action started (for /act). */
	readonly actionAt: number | undefined
}

export const ExecRequest = Schema.Struct({
	cmd: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
	timeout_ms: Schema.optionalKey(Schema.Int),
	max_bytes: Schema.optionalKey(Schema.Int),
	cwd: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	/** Detach and return at once; output goes to `log` (a path under /artifacts). */
	background: Schema.optionalKey(Schema.Boolean),
	log: Schema.optionalKey(Schema.String),
})
export type ExecRequest = typeof ExecRequest.Type

export const ExecResult = Schema.Struct({
	code: Schema.NullOr(Schema.Int),
	timed_out: Schema.Boolean,
	truncated: Schema.Boolean,
	stdout: Schema.String,
	stderr: Schema.String,
	pid: Schema.optionalKey(Schema.Int),
})
export type ExecResult = typeof ExecResult.Type

export const RecordStartRequest = Schema.Struct({ path: Schema.optionalKey(Schema.String) })
export const RecordStartResult = Schema.Struct({ mkv: Schema.String, startedAt: Schema.Finite })

export const RecordingResult = Schema.Struct({
	/** Wall-clock ms of the first captured frame; step times are relative to it. */
	t0: Schema.NullOr(Schema.Finite),
	duration: Schema.Finite,
	mkv: Schema.String,
	mp4: Schema.String,
})
export type RecordingResult = typeof RecordingResult.Type

export const NavigateRequest = Schema.Struct({ url: Schema.String, timeout_ms: Schema.optionalKey(Schema.Int) })
export const NavigateResult = Schema.Struct({
	at: Schema.Finite,
	url: Schema.String,
	status: Schema.NullOr(Schema.Int),
	error: Schema.optionalKey(Schema.String),
})
export type NavigateResult = typeof NavigateResult.Type

export const PageElement = Schema.Struct({
	ref: Schema.String,
	tag: Schema.String,
	role: Schema.optionalKey(Schema.String),
	type: Schema.optionalKey(Schema.String),
	name: Schema.String,
	value: Schema.optionalKey(Schema.String),
	checked: Schema.optionalKey(Schema.Boolean),
	disabled: Schema.optionalKey(Schema.Boolean),
	/** Centre in screen pixels. */
	x: Px,
	y: Px,
	w: Px,
	h: Px,
})
export type PageElement = typeof PageElement.Type

export const PageSnapshot = Schema.Struct({
	url: Schema.String,
	title: Schema.String,
	viewport: Schema.Struct({ x: Px, y: Px, w: Px, h: Px }),
	text: Schema.String,
	elements: Schema.Array(PageElement),
})
export type PageSnapshot = typeof PageSnapshot.Type

export const ConsoleMessage = Schema.Struct({ at: Schema.Finite, type: Schema.String, text: Schema.String, url: Schema.String })
export type ConsoleMessage = typeof ConsoleMessage.Type

export const NetworkEvent = Schema.Struct({
	at: Schema.Finite,
	kind: Schema.Literals(["failed", "status"]),
	method: Schema.String,
	url: Schema.String,
	status: Schema.optionalKey(Schema.Int),
	error: Schema.optionalKey(Schema.String),
})
export type NetworkEvent = typeof NetworkEvent.Type

export const EvaluateRequest = Schema.Struct({ expression: Schema.String })
export const EvaluateResult = Schema.Struct({ value: Schema.Unknown })

export const Health = Schema.Struct({
	ok: Schema.Boolean,
	display: Schema.String,
	recording: Schema.Boolean,
	browser: Schema.Boolean,
})
export type Health = typeof Health.Type

export const LogsResult = Schema.Struct({ file: Schema.String, lines: Schema.String })

/** Error body every non-2xx control response carries. */
export const ErrorBody = Schema.Struct({ error: Schema.String, tag: Schema.optionalKey(Schema.String) })
