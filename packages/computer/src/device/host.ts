// Commands on the Mac for device runs (simctl, avdmanager, the emulator, the app's
// dev server), and what a platform backend hands the device computer.
import { tmpdir } from "node:os"
import type { DeviceConfig } from "@witness/domain"
import { type Duration, Effect, Option, Schedule, type Scope } from "effect"
import { type ChildProcess, ChildProcessSpawner } from "effect/process"
import { DeviceError } from "../computer.ts"
import { messageOf } from "../message.ts"
import { runCommand } from "../server/exec.ts"
import { envWithout } from "../server/proc.ts"
import type { Argent } from "./argent.ts"

/** Devices witness creates are named `witness-<runId>-<pid>`, so cleanup can tell live runs from crashed ones. */
const NAME = /^witness-(.+)-(\d+)$/

/** Whether `name` is a device witness created for a run whose process has exited. */
export const isOrphan = (name: string) => {
	const m = NAME.exec(name)
	if (m === null) {
		return false
	}
	try {
		process.kill(Number(m[2]), 0)
		return false
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "EPERM"
	}
}

/** The device's name for a run. */
export const deviceName = (runId: string) => `witness-${runId}-${process.pid}`

/** Names of credentials (API keys, tokens, passwords) in the environment. */
const CREDENTIAL = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_|$)/i
export const isCredential = (name: string) => CREDENTIAL.test(name)

/**
 * This Mac's environment without witness's credentials. The app's setup and start
 * come from the repo under test; they get secrets only through witness.yaml.
 */
export const hostEnv = () => envWithout(isCredential)

/** Single-quotes `s` for `sh -c`. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const failWith = (operation: string) => (e: unknown) => new DeviceError({ message: messageOf(e), operation })

/** Runs an optional step; if it fails, logs `skipped` with the reason and carries on. */
export const optional =
	(skipped: string) =>
	<A, R>(step: Effect.Effect<A, DeviceError, R>) =>
		step.pipe(
			Effect.tapError((e) => Effect.logInfo(skipped, { reason: e.message.slice(0, 200) })),
			Effect.ignore
		)

/** Runs `check` now and every `every` until it returns true; false if `within` passes first. */
export const waitUntil = <E, R>(check: Effect.Effect<boolean, E, R>, every: Duration.Input, within: Duration.Input) =>
	check.pipe(
		Effect.repeat({ schedule: Schedule.spaced(every), until: (ok) => ok }),
		Effect.timeoutOption(within),
		Effect.map(Option.isSome)
	)

/** witness's own commands on this Mac (simctl, adb, ffmpeg), with the provider's process spawner. */
export type Host = {
	/** Runs `cmd` with `sh -c`: its trimmed stdout, or a DeviceError with the end of its output. */
	run: (operation: string, cmd: string, timeoutMs?: number) => Effect.Effect<string, DeviceError>
	/** Whether a command is on PATH. */
	onPath: (command: string) => Effect.Effect<boolean>
	/** Starts a long-running process, stopped (its process group) when the scope closes. */
	spawn: (
		operation: string,
		command: ChildProcess.Command
	) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, DeviceError, Scope.Scope>
}

export const makeHost = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const tools = { cwd: tmpdir(), env: hostEnv(), shell: ["sh", "-c"] } as const
	const run = (operation: string, cmd: string, timeoutMs = 120_000) =>
		runCommand(tools, { cmd, max_bytes: 4_000_000, timeout_ms: timeoutMs }).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			Effect.mapError(failWith(operation)),
			Effect.flatMap((r) =>
				r.code === 0
					? Effect.succeed(r.stdout.trim())
					: Effect.fail(
							new DeviceError({
								message: r.timed_out ? `timed out: ${cmd}` : (r.stderr.trim() || r.stdout.trim()).slice(-2000),
								operation,
							})
						)
			)
		)
	return {
		onPath: (command) =>
			run("which", `command -v ${q(command)}`).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			),
		run,
		spawn: (operation, command) => spawner.spawn(command).pipe(Effect.mapError(failWith(operation))),
	} satisfies Host
})

/** A running screen recording: when its first frame was captured, and how to finish the file. */
export type Recording = { readonly startedAt: number; readonly stop: Effect.Effect<void, DeviceError> }

/** A booted device with the app installed, from a platform backend. */
export type Device = {
	/** The simulator's UDID or the emulator's adb serial: argent's `udid`, and WITNESS_DEVICE_ID. */
	readonly id: string
	/** How to delete the device by hand, when the run keeps it. */
	readonly cleanup: string
	/** Opens a deep link in the app. */
	openLink: (url: string) => Effect.Effect<void, DeviceError>
	/** Starts recording the screen to `file` (any container ffmpeg reads). */
	record: (file: string) => Effect.Effect<Recording, DeviceError>
	/** The recording's file extension. */
	readonly videoExt: string
}

/** A platform: creates devices and removes the ones crashed runs left. */
export type Backend = {
	/** A fresh device with the app installed; the scope's close deletes it. */
	create: (runId: string, device: DeviceConfig, argent: Argent) => Effect.Effect<Device, DeviceError, Scope.Scope>
	/** Removes devices of runs whose process has exited; how many. */
	readonly cleanupOrphans: Effect.Effect<number>
}
