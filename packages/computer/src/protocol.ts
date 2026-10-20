// The control server's contract: endpoints, schemas and errors shared by the
// server (in the image) and the client (in the orchestrator), plus the constants
// both sides and the image (infra/computer) agree on.
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	HttpApiSecurity,
} from "effect/http-api"

/** The Xvfb screen (start.sh starts it at this size). */
export const SCREEN = { height: 1080, width: 1920 } as const
/** The X display everything draws on (the image sets `DISPLAY` to it). */
export const DISPLAY = ":1"
/** Port of the control server inside the computer. */
export const CONTROL_PORT = 7070
/**
 * Shutdown budget (seconds): ffmpeg gets this long after SIGINT to finalise a
 * recording before SIGKILL. start.sh waits this plus 2 s for the control server
 * (finalise, then remux); `docker stop` allows this plus 3 s.
 */
export const SHUTDOWN_GRACE_SECONDS = 3

/**
 * Chromium flags for a maximized window on the display. Shared by the control
 * server's Chromium and Playwright walkthroughs so both draw the same toolbar.
 */
export const CHROME_FLAGS: readonly string[] = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-dev-shm-usage",
	"--password-store=basic",
	"--start-maximized",
	`--window-size=${SCREEN.width},${SCREEN.height}`,
	"--window-position=0,0",
	// The container is the sandbox: CapDrop ALL + no-new-privileges leave Chromium
	// no way to build its own. --test-type hides the "unsupported flag" infobar.
	"--no-sandbox",
	"--test-type",
	"--disable-gpu",
	"--hide-crash-restore-bubble",
	"--disable-features=Translate,MediaRouter",
]

const Px = Schema.Finite

/** The browser window's geometry, as the page sees it. */
export const WindowMetrics = Schema.Struct({
	innerHeight: Px,
	innerWidth: Px,
	outerHeight: Px,
	outerWidth: Px,
	screenX: Px,
	screenY: Px,
})
export type WindowMetrics = typeof WindowMetrics.Type

/** Where the page's (0, 0) lands on screen: below the toolbar, inside the window frame. */
export const pageOrigin = (w: WindowMetrics): { readonly x: number; readonly y: number } => ({
	x: w.screenX + (w.outerWidth - w.innerWidth) / 2,
	y: w.screenY + w.outerHeight - w.innerHeight,
})

// --- errors -------------------------------------------------------------------

/** Missing or wrong bearer token. */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
	"UnauthorizedError",
	{ message: Schema.String },
	{ httpApiStatus: 401 }
) {}

/** A path outside /artifacts was requested. */
export class ArtifactPathError extends Schema.TaggedError<ArtifactPathError>()(
	"ArtifactPathError",
	{ message: Schema.String, path: Schema.String },
	{ httpApiStatus: 400 }
) {}

/** A requested artifact file does not exist. */
export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
	"ArtifactNotFoundError",
	{ message: Schema.String, path: Schema.String },
	{ httpApiStatus: 404 }
) {}

/** Start while recording, or stop while idle. */
export class RecordingStateError extends Schema.TaggedError<RecordingStateError>()(
	"RecordingStateError",
	{ message: Schema.String },
	{ httpApiStatus: 409 }
) {}

/** The display is not up yet. */
export class NotReadyError extends Schema.TaggedError<NotReadyError>()(
	"NotReadyError",
	{ message: Schema.String },
	{ httpApiStatus: 503 }
) {}

/** The display, Chromium, a shell command or ffmpeg failed. */
export class ServerError extends Schema.TaggedError<ServerError>()(
	"ServerError",
	{ message: Schema.String },
	{ httpApiStatus: 500 }
) {}

// --- schemas ------------------------------------------------------------------

export const ShotOptions = Schema.Struct({
	format: Schema.optionalKey(Schema.Literals(["png", "jpeg"])),
	quality: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: 100, minimum: 10 })))),
	/** Downscale to this width (keeps aspect ratio). Coordinates stay in screen pixels. */
	width: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: SCREEN.width, minimum: 160 })))),
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

const ImageMime = Schema.Literals(["image/png", "image/jpeg"])

/** Screenshot metadata travels in response headers next to the image bytes. */
const ShotHeaders = {
	/** The image's mime; it overrides the body's declared default. */
	"content-type": ImageMime,
	/** Wall-clock ms when the action started (for /act). */
	"x-action-at": Schema.optionalKey(Schema.Finite),
	/** Wall-clock ms (computer clock) when the screenshot was taken. */
	"x-at": Schema.Finite,
	"x-cursor-x": Px,
	"x-cursor-y": Px,
	"x-height": Schema.Int,
	"x-width": Schema.Int,
}

/** A screenshot: the image bytes as the body, its metadata in headers. */
export const Screenshot = Schema.Struct({
	actionAt: Schema.UndefinedOr(Schema.Finite),
	at: Schema.Finite,
	cursor: Schema.Struct({ x: Px, y: Px }),
	data: Schema.Uint8Array,
	height: Schema.Int,
	mime: ImageMime,
	width: Schema.Int,
}).pipe(
	HttpApiSchema.encodeToWithHeaders(
		{ body: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/png" })), headers: ShotHeaders },
		{
			decode: ({ body, headers: h }) => ({
				actionAt: h["x-action-at"],
				at: h["x-at"],
				cursor: { x: h["x-cursor-x"], y: h["x-cursor-y"] },
				data: body,
				height: h["x-height"],
				mime: h["content-type"],
				width: h["x-width"],
			}),
			encode: (s) => ({
				body: s.data,
				headers: {
					"content-type": s.mime,
					...(s.actionAt === undefined ? {} : { "x-action-at": s.actionAt }),
					"x-at": s.at,
					"x-cursor-x": s.cursor.x,
					"x-cursor-y": s.cursor.y,
					"x-height": s.height,
					"x-width": s.width,
				},
			}),
		}
	)
)
export type Screenshot = typeof Screenshot.Type

export const ExecRequest = Schema.Struct({
	cmd: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
	cwd: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	max_bytes: Schema.optionalKey(Schema.Int),
	timeout_ms: Schema.optionalKey(Schema.Int),
})
export type ExecRequest = typeof ExecRequest.Type

export const ExecResult = Schema.Struct({
	code: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
	stdout: Schema.String,
	timed_out: Schema.Boolean,
	truncated: Schema.Boolean,
})
export type ExecResult = typeof ExecResult.Type

/** A detached command that lives until the control server stops; output goes to `log` (under /artifacts). */
export const SpawnRequest = Schema.Struct({
	cmd: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
	cwd: Schema.optionalKey(Schema.String),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	log: Schema.String,
})
export type SpawnRequest = typeof SpawnRequest.Type

export const SpawnResult = Schema.Struct({ pid: Schema.Int })
export type SpawnResult = typeof SpawnResult.Type

export const RecordStartResult = Schema.Struct({ mkv: Schema.String, startedAt: Schema.Finite })
export type RecordStartResult = typeof RecordStartResult.Type

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

export const SnapshotRequest = Schema.Struct({ max_text: Schema.optionalKey(Schema.Int) })

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
/** The expression's value as JSON; absent when it is `undefined`. */
export const EvaluateResult = Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })

export const Health = Schema.Struct({ browser: Schema.Boolean, recording: Schema.Boolean })
export type Health = typeof Health.Type

// --- API ----------------------------------------------------------------------

/** Every endpoint but /health needs the per-run bearer token. */
export class ControlAuth extends HttpApiMiddleware.Service<ControlAuth>()("witness/computer/ControlAuth", {
	error: UnauthorizedError,
	security: { bearer: HttpApiSecurity.bearer },
}) {}

export class StatusGroup extends HttpApiGroup.make("status").add(
	HttpApiEndpoint.get("health", "/health", { error: NotReadyError, success: Health })
) {}

export class ControlGroup extends HttpApiGroup.make("control")
	.add(
		HttpApiEndpoint.post("screenshot", "/screenshot", {
			error: ServerError,
			payload: ShotOptions,
			success: Screenshot,
		}),
		HttpApiEndpoint.post("act", "/act", { error: ServerError, payload: ActRequest, success: Screenshot }),
		HttpApiEndpoint.post("exec", "/exec", { error: ServerError, payload: ExecRequest, success: ExecResult }),
		HttpApiEndpoint.post("spawn", "/spawn", {
			error: [ArtifactPathError, ServerError],
			payload: SpawnRequest,
			success: SpawnResult,
		}),
		HttpApiEndpoint.post("startRecording", "/record/start", {
			error: [RecordingStateError, ServerError],
			success: RecordStartResult,
		}),
		HttpApiEndpoint.post("stopRecording", "/record/stop", {
			error: [RecordingStateError, ServerError],
			success: RecordingResult,
		}),
		HttpApiEndpoint.post("navigate", "/browser/navigate", {
			error: ServerError,
			payload: NavigateRequest,
			success: NavigateResult,
		}),
		HttpApiEndpoint.post("snapshot", "/browser/snapshot", {
			error: ServerError,
			payload: SnapshotRequest,
			success: PageSnapshot,
		}),
		HttpApiEndpoint.post("evaluate", "/browser/evaluate", {
			error: ServerError,
			payload: EvaluateRequest,
			success: EvaluateResult,
		}),
		/** Console messages and page errors since the last call. */
		HttpApiEndpoint.post("console", "/browser/console", { success: Schema.Array(ConsoleMessage) }),
		/** Failed requests and >= 400 responses since the last call. */
		HttpApiEndpoint.post("network", "/browser/network", { success: Schema.Array(NetworkEvent) }),
		/** Last `tail` lines of a file under /artifacts. */
		HttpApiEndpoint.get("logs", "/logs", {
			error: [ArtifactPathError, ArtifactNotFoundError],
			query: { file: Schema.String, tail: Schema.Int },
			success: Schema.String.pipe(HttpApiSchema.asText()),
		})
	)
	.middleware(ControlAuth) {}

export class ControlApi extends HttpApi.make("witness-computer").add(StatusGroup, ControlGroup) {}
