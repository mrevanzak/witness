// The computer abstraction. One verification run = one fresh Computer whose
// lifetime is a Scope: leaving the scope tears down the container, its sibling
// services and its network. Docker is the MVP backend.
import { Context, Schema } from "effect"
import type { Effect, Scope } from "effect"
import type {
	ActRequest,
	ConsoleMessage,
	ExecRequest,
	ExecResult,
	Health,
	NavigateResult,
	NetworkEvent,
	PageSnapshot,
	RecordingResult,
	Screenshot,
	ShotOptions,
} from "./protocol.ts"

/** A control-server call failed (transport, non-2xx status, or an unexpected body). */
export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
	method: Schema.String,
	path: Schema.String,
	status: Schema.NullOr(Schema.Int),
	/** `_tag` of the server-side error, when the server reported one. */
	remoteTag: Schema.NullOr(Schema.String),
	message: Schema.String,
}) {}

/** A Docker API call failed while creating, inspecting or removing run resources. */
export class DockerError extends Schema.TaggedError<DockerError>()("DockerError", {
	operation: Schema.String,
	message: Schema.String,
}) {}

/** The computer image is missing locally. */
export class ComputerImageMissingError extends Schema.TaggedError<ComputerImageMissingError>()("ComputerImageMissingError", {
	image: Schema.String,
	message: Schema.String,
}) {}

/** The computer started but its control server never became healthy. */
export class ComputerStartTimeoutError extends Schema.TaggedError<ComputerStartTimeoutError>()("ComputerStartTimeoutError", {
	runId: Schema.String,
	message: Schema.String,
}) {}

export interface ServiceSpec {
	readonly image: string
	readonly env?: Readonly<Record<string, string>>
	readonly port?: number
	readonly command?: ReadonlyArray<string>
}

export interface ComputerSpec {
	readonly runId: string
	/** Host directory bind-mounted at /artifacts. */
	readonly artifactsDir: string
	readonly image?: string
	readonly env?: Readonly<Record<string, string>>
	readonly enableVnc?: boolean
	readonly memoryGb?: number
	readonly cpus?: number
}

export interface Computer {
	readonly id: string
	readonly runId: string
	/** Network the computer and its services share. */
	readonly network: string
	/** Control server address and token (for hand-driving a kept computer). The token is a secret. */
	readonly control: { readonly url: string; readonly token: string }
	/** Host URL of the noVNC live view, when enabled. */
	readonly liveView: string | undefined
	readonly health: Effect.Effect<Health, ControlError>
	screenshot(options?: ShotOptions): Effect.Effect<Screenshot, ControlError>
	act(request: ActRequest): Effect.Effect<Screenshot, ControlError>
	exec(request: ExecRequest): Effect.Effect<ExecResult, ControlError>
	/** Extracts a tar archive into `destDir` (entries keep the tar's ownership). */
	putArchive(tar: Uint8Array, destDir: string): Effect.Effect<void, DockerError>
	startRecording(path?: string): Effect.Effect<{ readonly mkv: string; readonly startedAt: number }, ControlError>
	readonly stopRecording: Effect.Effect<RecordingResult, ControlError>
	navigate(url: string, timeoutMs?: number): Effect.Effect<NavigateResult, ControlError>
	pageSnapshot(maxText?: number): Effect.Effect<PageSnapshot, ControlError>
	/** Evaluates an expression in the visible tab. For walkthroughs, never exposed to the model. */
	evaluate(expression: string): Effect.Effect<unknown, ControlError>
	readonly consoleMessages: Effect.Effect<ReadonlyArray<ConsoleMessage>, ControlError>
	readonly networkEvents: Effect.Effect<ReadonlyArray<NetworkEvent>, ControlError>
	logs(file: string, tail?: number): Effect.Effect<string, ControlError>
	/** Starts a sibling service container on the run network, reachable at `name`. */
	startService(name: string, spec: ServiceSpec): Effect.Effect<void, DockerError>
}

export class ComputerProvider extends Context.Service<
	ComputerProvider,
	{
		/** A fresh computer, destroyed when the surrounding scope closes (unless `keep`). */
		create(spec: ComputerSpec & { readonly keep?: boolean }): Effect.Effect<Computer, DockerError | ComputerImageMissingError | ComputerStartTimeoutError, Scope.Scope>
		/** Removes computers and networks left behind by crashed runs; returns how many runs it cleaned. */
		readonly cleanupOrphans: Effect.Effect<number, DockerError>
		/** Removes everything of one run. */
		removeRun(runId: string): Effect.Effect<void, DockerError>
	}
>()("witness/computer/ComputerProvider") {}
