// The computer abstraction. One verification run = one fresh Computer whose
// lifetime is a Scope: leaving the scope tears down the container, its sibling
// services and its network. Docker is the MVP backend.

import type { ServiceSpec } from "@witness/domain"
import type { Effect, Scope } from "effect"
import { Context, Schema } from "effect"
import type { ControlClient } from "./control-client.ts"

/** A control-server call failed (transport, timeout, an error response, or an unexpected body). */
export class ControlError extends Schema.TaggedError<ControlError>()("ControlError", {
	/** The control endpoint, e.g. `act`. */
	endpoint: Schema.String,
	message: Schema.String,
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

export type ComputerSpec = {
	/** Host directory bind-mounted at /artifacts. */
	readonly artifactsDir: string
	readonly cpus?: number
	readonly enableVnc?: boolean
	/** Leave the computer running when the scope closes. */
	readonly keep?: boolean
	readonly memoryGb?: number
	readonly runId: string
}

/** What the provider adds around the control client: the container and its network. */
export type ComputerHandle = {
	readonly id: string
	/** Host URL of the noVNC live view, when enabled. */
	readonly liveView: string | undefined
	/** Network the computer and its services share. */
	readonly network: string
	/** Extracts a tar archive into `destDir` (entries keep the tar's ownership). */
	putArchive: (tar: Uint8Array, destDir: string) => Effect.Effect<void, DockerError>
	readonly runId: string
	/** Starts a sibling service container on the run network, reachable at `name`. */
	startService: (name: string, spec: ServiceSpec) => Effect.Effect<void, DockerError>
}

export type Computer = ControlClient & ComputerHandle

export class ComputerProvider extends Context.Service<
	ComputerProvider,
	{
		/** A fresh computer, destroyed when the surrounding scope closes (unless `keep`). */
		create: (
			spec: ComputerSpec
		) => Effect.Effect<Computer, DockerError | ComputerImageMissingError | ComputerStartTimeoutError, Scope.Scope>
		/** Removes computers and networks left behind by crashed runs; returns how many runs it cleaned. */
		readonly cleanupOrphans: Effect.Effect<number, DockerError>
	}
>()("witness/computer/ComputerProvider") {}
