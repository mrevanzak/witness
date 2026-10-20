// The computer abstraction. One verification run = one fresh Computer whose
// lifetime is a Scope: leaving the scope tears down the container, its sibling
// services and its network. Docker is the MVP backend.

import type { Effect, Scope } from "effect"
import { Context, Schema } from "effect"
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
	message: Schema.String,
	method: Schema.String,
	path: Schema.String,
	/** `_tag` of the server-side error, when the server reported one. */
	remoteTag: Schema.NullOr(Schema.String),
	status: Schema.NullOr(Schema.Int),
}) {}

/** A Docker API call failed while creating, inspecting or removing run resources. */
export class DockerError extends Schema.TaggedError<DockerError>()("DockerError", {
	message: Schema.String,
	operation: Schema.String,
}) {}

/** The computer image is missing locally. */
export class ComputerImageMissingError extends Schema.TaggedError<ComputerImageMissingError>()(
	"ComputerImageMissingError",
	{
		image: Schema.String,
		message: Schema.String,
	}
) {}

/** The computer started but its control server never became healthy. */
export class ComputerStartTimeoutError extends Schema.TaggedError<ComputerStartTimeoutError>()(
	"ComputerStartTimeoutError",
	{
		message: Schema.String,
		runId: Schema.String,
	}
) {}

export type ServiceSpec = {
	readonly command?: readonly string[]
	readonly env?: Readonly<Record<string, string>>
	readonly image: string
	readonly port?: number
}

export type ComputerSpec = {
	/** Host directory bind-mounted at /artifacts. */
	readonly artifactsDir: string
	readonly cpus?: number
	readonly enableVnc?: boolean
	readonly env?: Readonly<Record<string, string>>
	readonly image?: string
	readonly memoryGb?: number
	readonly runId: string
}

export type Computer = {
	act: (request: ActRequest) => Effect.Effect<Screenshot, ControlError>
	readonly consoleMessages: Effect.Effect<readonly ConsoleMessage[], ControlError>
	/** Control server address and token (for hand-driving a kept computer). The token is a secret. */
	readonly control: { readonly url: string; readonly token: string }
	/** Evaluates an expression in the visible tab. For walkthroughs, never exposed to the model. */
	evaluate: (expression: string) => Effect.Effect<unknown, ControlError>
	exec: (request: ExecRequest) => Effect.Effect<ExecResult, ControlError>
	readonly health: Effect.Effect<Health, ControlError>
	readonly id: string
	/** Host URL of the noVNC live view, when enabled. */
	readonly liveView: string | undefined
	logs: (file: string, tail?: number) => Effect.Effect<string, ControlError>
	navigate: (url: string, timeoutMs?: number) => Effect.Effect<NavigateResult, ControlError>
	/** Network the computer and its services share. */
	readonly network: string
	readonly networkEvents: Effect.Effect<readonly NetworkEvent[], ControlError>
	pageSnapshot: (maxText?: number) => Effect.Effect<PageSnapshot, ControlError>
	/** Extracts a tar archive into `destDir` (entries keep the tar's ownership). */
	putArchive: (tar: Uint8Array, destDir: string) => Effect.Effect<void, DockerError>
	readonly runId: string
	screenshot: (options?: ShotOptions) => Effect.Effect<Screenshot, ControlError>
	startRecording: (path?: string) => Effect.Effect<{ readonly mkv: string; readonly startedAt: number }, ControlError>
	/** Starts a sibling service container on the run network, reachable at `name`. */
	startService: (name: string, spec: ServiceSpec) => Effect.Effect<void, DockerError>
	readonly stopRecording: Effect.Effect<RecordingResult, ControlError>
}

export class ComputerProvider extends Context.Service<
	ComputerProvider,
	{
		/** A fresh computer, destroyed when the surrounding scope closes (unless `keep`). */
		create: (
			spec: ComputerSpec & { readonly keep?: boolean }
		) => Effect.Effect<Computer, DockerError | ComputerImageMissingError | ComputerStartTimeoutError, Scope.Scope>
		/** Removes computers and networks left behind by crashed runs; returns how many runs it cleaned. */
		readonly cleanupOrphans: Effect.Effect<number, DockerError>
		/** Removes everything of one run. */
		removeRun: (runId: string) => Effect.Effect<void, DockerError>
	}
>()("witness/computer/ComputerProvider") {}
