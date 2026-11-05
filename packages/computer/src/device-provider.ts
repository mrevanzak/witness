// ComputerProvider for a device app: a fresh iOS simulator or Android emulator per
// run, the app installed on it, and deleted when the run's scope closes. The app's
// setup and start commands (npm ci, Metro) run on this Mac in a temporary copy of the
// commit; argent drives the device; the platform backend (device/ios.ts,
// device/android.ts) creates it, opens deep links and records its screen.
//
// shortcut: simulators and emulators only; physical phones are next.

import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Option } from "effect"
import { type Computer, ComputerProvider, type ComputerSpec, ControlError, DeviceError } from "./computer.ts"
import { cleanupEmulators, createEmulator } from "./device/android.ts"
import { loadArgent } from "./device/argent.ts"
import { gestureFor } from "./device/gestures.ts"
import { failWith, host, q, type Recording, runShell, sleep, stopGroup } from "./device/host.ts"
import { cleanupSimulators, createSimulator } from "./device/ios.ts"
import { parseScreenTree } from "./device/screen-tree.ts"
import { messageOf } from "./message.ts"
import type { Health, RecordingResult, Screenshot, ShotOptions } from "./protocol.ts"

export { pickDeviceType, pickImage } from "./device/android.ts"
export { pickSimulator } from "./device/ios.ts"

const pngSize = (png: Uint8Array) => {
	const b = Buffer.from(png)
	return { height: b.readUInt32BE(20), width: b.readUInt32BE(16) }
}

export const makeDeviceProvider = Effect.gen(function* () {
	const cleanupOrphans = Effect.all([
		cleanupSimulators.pipe(Effect.orElseSucceed(() => 0)),
		cleanupEmulators.pipe(Effect.orElseSucceed(() => 0)),
	]).pipe(
		Effect.map(([a, b]) => a + b),
		Effect.withSpan("DeviceComputerProvider.cleanupOrphans")
	)

	const create = Effect.fn("DeviceComputerProvider.create")(function* (spec: ComputerSpec) {
		const config = spec.device
		if (config === undefined) {
			return yield* new DeviceError({ message: "no device in the spec", operation: "create" })
		}
		const argent = yield* loadArgent
		const artifacts = resolve(spec.artifactsDir)
		const workDir = join(tmpdir(), `witness-${spec.runId}`)
		const app = join(workDir, "app")
		yield* Effect.tryPromise({
			catch: failWith("workDir"),
			try: async () => {
				await mkdir(artifacts, { recursive: true })
				await mkdir(app, { recursive: true })
				await stat(config.app)
			},
		})
		if (!spec.keep) {
			yield* Effect.addFinalizer(() => Effect.promise(() => rm(workDir, { force: true, recursive: true })))
		}

		// 1. A fresh device with the app on it.
		const device =
			config.platform === "ios"
				? yield* createSimulator(spec.runId, config, spec.keep === true, argent)
				: yield* createEmulator(spec.runId, config, spec.keep === true, argent)
		const udid = device.id

		// 2. Processes the run starts on the host (the app's dev server) stop with it.
		const env: NodeJS.ProcessEnv = { ...process.env, WITNESS_DEVICE_ID: udid }
		const spawned: ChildProcess[] = []
		yield* Effect.addFinalizer(() =>
			spec.keep
				? Effect.sync(() => {
						// Kept processes outlive witness, so they must not hold its event loop open.
						for (const c of spawned) {
							c.unref()
						}
					}).pipe(Effect.andThen(Effect.logInfo("processes kept", { pids: spawned.map((c) => c.pid) })))
				: Effect.promise(() => Promise.all(spawned.map((c) => stopGroup(c, 3000)))).pipe(Effect.asVoid)
		)

		const control = (endpoint: string) => (e: unknown) => new ControlError({ endpoint, message: messageOf(e) })

		/** Where argent saved a screenshot at `scale` (1 = full resolution). */
		const capture = (scale: number) =>
			argent.call<{ image: string }>("screenshot", { scale, udid }).pipe(Effect.map((r) => r.image))
		const read = (file: string) => Effect.tryPromise({ catch: failWith("screenshot"), try: () => readFile(file) })

		const screen = pngSize(yield* capture(1).pipe(Effect.flatMap(read)))
		let cursor = { x: screen.width / 2, y: screen.height / 2 }
		let lastUrl = ""

		const shoot = (options: ShotOptions = {}) =>
			Effect.gen(function* () {
				const at = Date.now()
				const scale = options.width ? Math.min(1, options.width / screen.width) : 1
				const image = yield* capture(scale)
				let data: Uint8Array = yield* read(image)
				const size = pngSize(data)
				let mime: Screenshot["mime"] = "image/png"
				if (options.format === "jpeg") {
					const jpg = `${image}.jpg`
					yield* host(
						"jpeg",
						`sips -s format jpeg -s formatOptions ${options.quality ?? 80} ${q(image)} --out ${q(jpg)}`
					)
					data = yield* read(jpg)
					mime = "image/jpeg"
				}
				return { actionAt: undefined, at, cursor, data, mime, ...size } satisfies Screenshot
			})

		let recording: Option.Option<Recording & { readonly file: string }> = Option.none()
		const stopRecording = Effect.gen(function* () {
			if (Option.isNone(recording)) {
				return yield* new DeviceError({ message: "not recording", operation: "stopRecording" })
			}
			const { file, startedAt, stop } = recording.value
			recording = Option.none()
			const stoppedAt = Date.now()
			yield* stop
			// Simulators write a frame only when the screen changes and stop at the last change;
			// a constant 30 fps that holds the last frame until the real stop keeps step times true.
			const duration = (stoppedAt - startedAt) / 1000
			const mp4 = join(artifacts, "raw.mp4")
			yield* host(
				"remux",
				`ffmpeg -hide_banner -loglevel error -y -i ${q(file)} -an -vf ${q(`fps=30,tpad=stop_mode=clone:stop_duration=${duration}`)} -t ${duration} -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -movflags +faststart ${q(mp4)}`,
				600_000
			)
			return { duration, mkv: file, mp4, t0: startedAt } satisfies RecordingResult
		})
		yield* Effect.addFinalizer(() => (Option.isSome(recording) ? Effect.ignore(stopRecording) : Effect.void))

		const computer: Computer = {
			act: ({ action, settle_ms, shot }) =>
				Effect.gen(function* () {
					const actionAt = Date.now()
					if (action.type === "wait") {
						yield* sleep(action.ms)
					} else {
						const g = gestureFor(action, screen)
						if (g && "unsupported" in g) {
							return yield* new DeviceError({ message: g.unsupported, operation: action.type })
						}
						if (g) {
							yield* argent.call(g.tool, { ...g.args, udid })
						}
						if ("x" in action && action.x !== undefined && action.y !== undefined) {
							cursor = action.type === "drag" ? { x: action.to_x, y: action.to_y } : { x: action.x, y: action.y }
						}
					}
					yield* sleep(settle_ms ?? 300)
					return { ...(yield* shoot(shot)), actionAt }
				}).pipe(Effect.mapError(control("act"))),
			consoleMessages: Effect.succeed([]),
			evaluate: () =>
				Effect.fail(new ControlError({ endpoint: "evaluate", message: "eval is not available on a device app" })),
			exec: (r) =>
				Effect.tryPromise({
					catch: control("exec"),
					try: () =>
						runShell(r.cmd, {
							cwd: r.cwd ?? app,
							env: { ...env, ...r.env },
							maxBytes: r.max_bytes ?? 1_000_000,
							timeoutMs: r.timeout_ms ?? 30_000,
						}),
				}),
			health: Effect.sync((): Health => ({ browser: true, recording: Option.isSome(recording) })),
			id: udid,
			kind: "phone",
			liveView: undefined,
			logs: (file, tail = 200) =>
				Effect.promise(() =>
					readFile(join(artifacts, file), "utf8")
						.then((t) => t.split("\n").slice(-tail).join("\n"))
						.catch(() => "")
				),
			navigate: (url) =>
				Effect.gen(function* () {
					const at = Date.now()
					lastUrl = url
					const opened = yield* device.openLink(url).pipe(Effect.result)
					if (opened._tag === "Failure") {
						return { at, error: opened.failure.message, status: null, url }
					}
					// Let the app load what the link opens (a dev build downloads its JS bundle) before anyone looks.
					yield* argent.call("await-screen-idle", { minStableMs: 2000, timeoutMs: 120_000, udid }).pipe(Effect.ignore)
					return { at, status: null, url }
				}).pipe(Effect.mapError(control("navigate"))),
			network: "host",
			networkEvents: Effect.succeed([]),
			pageSnapshot: (maxText) =>
				argent.call<{ description: string }>("describe", { udid }).pipe(
					Effect.map(({ description }) => ({
						...parseScreenTree(description, screen, maxText),
						title: "",
						url: lastUrl,
						viewport: { h: screen.height, w: screen.width, x: 0, y: 0 },
					})),
					Effect.mapError(control("snapshot"))
				),
			paths: { app, artifacts },
			putArchive: (tar, destDir) =>
				Effect.tryPromise({
					catch: failWith("putArchive"),
					try: async () => {
						await mkdir(destDir, { recursive: true })
						const r = await runShell(`tar -x -f - -C ${q(destDir)}`, {
							cwd: destDir,
							env: process.env,
							input: tar,
							maxBytes: 100_000,
							timeoutMs: 300_000,
						})
						if (r.code !== 0) {
							throw new Error(r.stderr || `tar exited ${r.code}`)
						}
					},
				}),
			runId: spec.runId,
			screen,
			screenshot: (options) => shoot(options).pipe(Effect.mapError(control("screenshot"))),
			spawn: (r) =>
				Effect.try({
					catch: control("spawn"),
					try: () => {
						const child = spawn("sh", ["-c", `{ ${r.cmd} ; } >> ${q(join(artifacts, r.log))} 2>&1`], {
							cwd: r.cwd ?? app,
							detached: true,
							env: { ...env, ...r.env },
							stdio: "ignore",
						})
						spawned.push(child)
						return { pid: child.pid ?? -1 }
					},
				}),
			startRecording: Effect.gen(function* () {
				if (Option.isSome(recording)) {
					return yield* new DeviceError({ message: "already recording", operation: "startRecording" })
				}
				const file = join(artifacts, `raw.device.${device.videoExt}`)
				const started = yield* device.record(file)
				recording = Option.some({ ...started, file })
				return { mkv: file, startedAt: started.startedAt }
			}).pipe(Effect.mapError(control("startRecording"))),
			startService: (name) =>
				Effect.fail(
					new DeviceError({ message: `services are not supported on a device app (${name})`, operation: "service" })
				),
			stopRecording: stopRecording.pipe(Effect.mapError(control("stopRecording"))),
		}
		return computer
	})

	return ComputerProvider.of({ cleanupOrphans, create })
})
