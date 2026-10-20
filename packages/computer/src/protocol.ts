// Wire protocol of the computer's control server: request/response schemas shared
// by the server (in the image) and the client (in the orchestrator).
import { Schema } from "effect"

export const SCREEN_W = 1920
export const SCREEN_H = 1080

const Px = Schema.Finite

export const ShotOptions = Schema.Struct({
	format: Schema.optionalKey(Schema.Literals(["png", "jpeg"])),
	quality: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 100, minimum: 10 })))),
	/** Downscale to this width (keeps aspect ratio). Coordinates stay in screen pixels. */
	width: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: SCREEN_W, minimum: 160 })))),
})
export type ShotOptions = typeof ShotOptions.Type

export const Action = Schema.Union([
	Schema.Struct({
		button: Schema.optionalKey(Schema.Literals(["left", "middle"])),
		type: Schema.Literals(["click", "double_click", "right_click", "move"]),
		x: Px,
		y: Px,
	}),
	Schema.Struct({ to_x: Px, to_y: Px, type: Schema.Literal("drag"), x: Px, y: Px }),
	Schema.Struct({ delay_ms: Schema.optionalKey(Schema.Int), text: Schema.String, type: Schema.Literal("type") }),
	Schema.Struct({ combo: Schema.String.pipe(Schema.check(Schema.isNonEmpty())), type: Schema.Literal("key") }),
	Schema.Struct({
		dx: Schema.optionalKey(Schema.Int),
		dy: Schema.optionalKey(Schema.Int),
		type: Schema.Literal("scroll"),
		x: Schema.optionalKey(Px),
		y: Schema.optionalKey(Px),
	}),
	Schema.Struct({
		ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 30_000, minimum: 0 }))),
		type: Schema.Literal("wait"),
	}),
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
	actionAt: "x-action-at",
	at: "x-at",
	cursorX: "x-cursor-x",
	cursorY: "x-cursor-y",
	height: "x-height",
	width: "x-width",
} as const

export type Screenshot = {
	/** Wall-clock ms when the action started (for /act). */
	readonly actionAt: number | undefined
	/** Wall-clock ms (computer clock) when the screenshot was taken. */
	readonly at: number
	readonly cursor: { readonly x: number; readonly y: number }
	readonly data: Uint8Array
	readonly height: number
	readonly mime: "image/png" | "image/jpeg"
	readonly width: number
}

export const ExecRequest = Schema.Struct({
	/** Detach and return at once; output goes to `log` (a path under /artifacts). */
	background: Schema.optionalKey(Schema.Boolean),
	cmd: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
	cwd: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	log: Schema.optionalKey(Schema.String),
	max_bytes: Schema.optionalKey(Schema.Int),
	timeout_ms: Schema.optionalKey(Schema.Int),
})
export type ExecRequest = typeof ExecRequest.Type

export const ExecResult = Schema.Struct({
	code: Schema.NullOr(Schema.Int),
	pid: Schema.optionalKey(Schema.Int),
	stderr: Schema.String,
	stdout: Schema.String,
	timed_out: Schema.Boolean,
	truncated: Schema.Boolean,
})
export type ExecResult = typeof ExecResult.Type

export const RecordStartRequest = Schema.Struct({ path: Schema.optionalKey(Schema.String) })
export const RecordStartResult = Schema.Struct({ mkv: Schema.String, startedAt: Schema.Finite })

export const RecordingResult = Schema.Struct({
	duration: Schema.Finite,
	mkv: Schema.String,
	mp4: Schema.String,
	/** Wall-clock ms of the first captured frame; step times are relative to it. */
	t0: Schema.NullOr(Schema.Finite),
})
export type RecordingResult = typeof RecordingResult.Type

export const NavigateRequest = Schema.Struct({ timeout_ms: Schema.optionalKey(Schema.Int), url: Schema.String })
export const NavigateResult = Schema.Struct({
	at: Schema.Finite,
	error: Schema.optionalKey(Schema.String),
	status: Schema.NullOr(Schema.Int),
	url: Schema.String,
})
export type NavigateResult = typeof NavigateResult.Type

export const PageElement = Schema.Struct({
	checked: Schema.optionalKey(Schema.Boolean),
	disabled: Schema.optionalKey(Schema.Boolean),
	h: Px,
	name: Schema.String,
	ref: Schema.String,
	role: Schema.optionalKey(Schema.String),
	tag: Schema.String,
	type: Schema.optionalKey(Schema.String),
	value: Schema.optionalKey(Schema.String),
	w: Px,
	/** Centre in screen pixels. */
	x: Px,
	y: Px,
})
export type PageElement = typeof PageElement.Type

export const PageSnapshot = Schema.Struct({
	elements: Schema.Array(PageElement),
	text: Schema.String,
	title: Schema.String,
	url: Schema.String,
	viewport: Schema.Struct({ h: Px, w: Px, x: Px, y: Px }),
})
export type PageSnapshot = typeof PageSnapshot.Type

export const ConsoleMessage = Schema.Struct({
	at: Schema.Finite,
	text: Schema.String,
	type: Schema.String,
	url: Schema.String,
})
export type ConsoleMessage = typeof ConsoleMessage.Type

export const NetworkEvent = Schema.Struct({
	at: Schema.Finite,
	error: Schema.optionalKey(Schema.String),
	kind: Schema.Literals(["failed", "status"]),
	method: Schema.String,
	status: Schema.optionalKey(Schema.Int),
	url: Schema.String,
})
export type NetworkEvent = typeof NetworkEvent.Type

export const EvaluateRequest = Schema.Struct({ expression: Schema.String })
export const EvaluateResult = Schema.Struct({ value: Schema.Unknown })

export const Health = Schema.Struct({
	browser: Schema.Boolean,
	display: Schema.String,
	ok: Schema.Boolean,
	recording: Schema.Boolean,
})
export type Health = typeof Health.Type

export const LogsResult = Schema.Struct({ file: Schema.String, lines: Schema.String })

/** Error body every non-2xx control response carries. */
export const ErrorBody = Schema.Struct({ error: Schema.String, tag: Schema.optionalKey(Schema.String) })
