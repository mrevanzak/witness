// The computer abstraction. One verification run = one fresh Computer whose
// lifetime is a Scope: leaving the scope tears down the container, its sibling
// services and its network (Docker), or the simulator or emulator and the processes the run
// started on the host (a device app).

import type { DeviceConfig, ServiceSpec } from "@witness/domain"
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

/** Creating, driving or deleting the simulator or emulator of a device run failed. */
export class DeviceError extends Schema.TaggedError<DeviceError>()("DeviceError", {
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
	/** A simulator or emulator for a device app instead of the Linux computer. */
	readonly device?: DeviceConfig
	readonly enableVnc?: boolean
	/** Leave the computer running when the scope closes. */
	readonly keep?: boolean
	readonly memoryGb?: number
	readonly runId: string
}

/** What the provider adds around the control client: the container and its network. */
export type ComputerHandle = {
	readonly id: string
	/** What the tester looks at: a Linux desktop with Chromium, or a phone (simulator or emulator). */
	readonly kind: "desktop" | "phone"
	/** Host URL of the noVNC live view, when enabled. */
	readonly liveView: string | undefined
	/** Network the computer and its services share. */
	readonly network: string
	/** Where commands see the app's source and the run's artifacts (logs go under `artifacts`). */
	readonly paths: { readonly app: string; readonly artifacts: string }
	/** Extracts a tar archive into `destDir` (entries keep the tar's ownership). */
	putArchive: (tar: Uint8Array, destDir: string) => Effect.Effect<void, DockerError | DeviceError>
	readonly runId: string
	/** Screen size in pixels; action coordinates and full screenshots use it. */
	readonly screen: { readonly width: number; readonly height: number }
	/** Starts a sibling service container on the run network, reachable at `name`. */
	startService: (name: string, spec: ServiceSpec) => Effect.Effect<void, DockerError | DeviceError>
}

export type Computer = ControlClient & ComputerHandle

export class ComputerProvider extends Context.Service<
	ComputerProvider,
	{
		/** A fresh computer, destroyed when the surrounding scope closes (unless `keep`). */
		create: (
			spec: ComputerSpec
		) => Effect.Effect<
			Computer,
			DockerError | DeviceError | ComputerImageMissingError | ComputerStartTimeoutError,
			Scope.Scope
		>
		/** Removes computers and networks whose witness process has exited; returns how many runs it cleaned. */
		readonly cleanupOrphans: Effect.Effect<number, DockerError>
	}
>()("witness/computer/ComputerProvider") {}
