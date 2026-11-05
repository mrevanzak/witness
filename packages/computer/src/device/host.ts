// Commands on the Mac for device runs (simctl, avdmanager, the emulator, the app's
// dev server), and what a platform backend hands the device computer.
import { type ChildProcess, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { DeviceError } from "../computer.ts"
import { messageOf } from "../message.ts"

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

export type Shell = { code: number | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean }

/** Runs `sh -c cmd` in its own process group, so a timeout kills everything it started. */
export const runShell = (
	cmd: string,
	o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number; input?: Uint8Array }
) =>
	new Promise<Shell>((done, fail) => {
		const child = spawn("sh", ["-c", cmd], { cwd: o.cwd, detached: true, env: o.env, stdio: "pipe" })
		const out = { stderr: "", stdout: "", truncated: false }
		const take = (key: "stdout" | "stderr") => (chunk: Buffer) => {
			const room = o.maxBytes - out[key].length
			out.truncated ||= chunk.length > room
			out[key] += chunk.subarray(0, Math.max(0, room)).toString()
		}
		child.stdout.on("data", take("stdout"))
		child.stderr.on("data", take("stderr"))
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			killGroup(child, "SIGKILL")
		}, o.timeoutMs)
		child.on("error", (e) => {
			clearTimeout(timer)
			fail(e)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			done({ code: timedOut ? null : code, timed_out: timedOut, ...out })
		})
		child.stdin.end(o.input ? Buffer.from(o.input) : undefined)
	})

export const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
	try {
		if (child.pid !== undefined) {
			process.kill(-child.pid, signal)
		}
	} catch {
		// Already gone.
	}
}

/** Stops a process group: SIGTERM, then SIGKILL after `graceMs`. */
export const stopGroup = (child: ChildProcess, graceMs: number) =>
	new Promise<void>((done) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			done()
			return
		}
		const timer = setTimeout(() => killGroup(child, "SIGKILL"), graceMs)
		child.once("exit", () => {
			clearTimeout(timer)
			done()
		})
		killGroup(child, "SIGTERM")
	})

/** Single-quotes `s` for `sh -c`. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const sleep = (ms: number) => Effect.sleep(`${ms} millis`)

export const failWith = (operation: string) => (e: unknown) => new DeviceError({ message: messageOf(e), operation })

/** Runs a host command; its trimmed stdout, or a DeviceError with the end of its output. */
export const host = (operation: string, cmd: string, timeoutMs = 120_000) =>
	Effect.tryPromise({
		catch: failWith(operation),
		try: () => runShell(cmd, { cwd: tmpdir(), env: process.env, maxBytes: 4_000_000, timeoutMs }),
	}).pipe(
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

/** Runs an optional step; if it fails, logs `skipped` with the reason and carries on. */
export const optional =
	(skipped: string) =>
	<A, R>(step: Effect.Effect<A, DeviceError, R>) =>
		step.pipe(
			Effect.tapError((e) => Effect.logInfo(skipped, { reason: e.message.slice(0, 200) })),
			Effect.ignore
		)

/** Whether a command is on PATH. */
export const onPath = (command: string) =>
	host("which", `command -v ${q(command)}`).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false)
	)

/** A running screen recording: when its first frame was captured, and how to finish the file. */
export type Recording = { readonly startedAt: number; readonly stop: Effect.Effect<void, DeviceError> }

/** A booted device with the app installed, from a platform backend. Its scope deletes it. */
export type Device = {
	/** The simulator's UDID or the emulator's adb serial: argent's `udid`, and WITNESS_DEVICE_ID. */
	readonly id: string
	/** Opens a deep link in the app. */
	openLink: (url: string) => Effect.Effect<void, DeviceError>
	/** Starts recording the screen to `file` (any container ffmpeg reads). */
	record: (file: string) => Effect.Effect<Recording, DeviceError>
	/** The recording's file extension. */
	readonly videoExt: string
}
