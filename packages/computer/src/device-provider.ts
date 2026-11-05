// ComputerProvider for a device app: a fresh iOS simulator per run, created with
// simctl, the app installed on it, and deleted when the run's scope closes. The
// app's setup and start commands (npm ci, Metro) run on this Mac in a temporary
// copy of the commit; argent drives the simulator; simctl records its screen.
//
// shortcut: iOS simulators only; Android emulators and physical phones are next.

import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Option } from "effect"
import { type Computer, ComputerProvider, type ComputerSpec, ControlError, DeviceError } from "./computer.ts"
import { loadArgent } from "./device/argent.ts"
import { gestureFor } from "./device/gestures.ts"
import { parseScreenTree } from "./device/screen-tree.ts"
import { messageOf } from "./message.ts"
import type { Health, RecordingResult, Screenshot, ShotOptions } from "./protocol.ts"

/** Simulators witness creates are named `witness-<runId>-<pid>`, so cleanup can tell live runs from crashed ones. */
const NAME = /^witness-(.+)-(\d+)$/
const ownerAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

type Shell = { code: number | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean }

/** Runs `sh -c cmd` in its own process group, so a timeout kills everything it started. */
const runShell = (
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

const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
	try {
		if (child.pid !== undefined) {
			process.kill(-child.pid, signal)
		}
	} catch {
		// Already gone.
	}
}

/** Stops a process group: SIGTERM, then SIGKILL after `graceMs`. */
const stopGroup = (child: ChildProcess, graceMs: number) =>
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

const pngSize = (png: Uint8Array) => {
	const b = Buffer.from(png)
	return { height: b.readUInt32BE(20), width: b.readUInt32BE(16) }
}

const sleep = (ms: number) => Effect.sleep(`${ms} millis`)

type SimRuntime = {
	readonly identifier: string
	readonly isAvailable: boolean
	readonly name: string
	readonly platform?: string
	readonly version: string
	readonly supportedDeviceTypes?: ReadonlyArray<{ identifier: string; name: string; productFamily?: string }>
}

const versionKey = (v: string) => v.split(".").map((n) => n.padStart(4, "0"))

/** Picks the runtime and device type: the configured ones, or the newest iOS and its newest iPhone. */
export const pickSimulator = (
	runtimes: readonly SimRuntime[],
	want: { readonly runtime?: string; readonly type?: string }
): { runtime: string; type: string } | string => {
	const ios = runtimes
		.filter((r) => r.isAvailable && (r.platform ?? r.name.split(" ")[0]) === "iOS")
		.sort((a, b) => (versionKey(a.version).join() < versionKey(b.version).join() ? -1 : 1))
	const runtime = want.runtime
		? ios.find((r) => [r.name, r.identifier, `iOS ${r.version}`, r.version].includes(want.runtime ?? ""))
		: ios.at(-1)
	if (!runtime) {
		return want.runtime
			? `no available simulator runtime ${want.runtime}; installed: ${ios.map((r) => r.name).join(", ") || "none"}`
			: "no iOS simulator runtime is installed (Xcode > Settings > Components)"
	}
	const types = runtime.supportedDeviceTypes ?? []
	const type = want.type
		? types.find((t) => t.name === want.type || t.identifier === want.type)
		: types.filter((t) => t.productFamily === "iPhone").at(-1)
	if (!type) {
		return want.type
			? `${runtime.name} has no device type ${want.type}; e.g. ${types
					.filter((t) => t.productFamily === "iPhone")
					.map((t) => t.name)
					.join(", ")}`
			: `${runtime.name} supports no iPhone`
	}
	return { runtime: runtime.identifier, type: type.identifier }
}

export const makeDeviceProvider = Effect.gen(function* () {
	const fail = (operation: string) => (e: unknown) => new DeviceError({ message: messageOf(e), operation })
	const host = (operation: string, cmd: string, timeoutMs = 120_000) =>
		Effect.tryPromise({
			catch: fail(operation),
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
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
	const simctl = (operation: string, args: string, timeoutMs?: number) =>
		host(operation, `xcrun simctl ${args}`, timeoutMs)

	/** Shuts down and deletes a simulator; never fails. */
	const deleteSimulator = (udid: string) =>
		simctl("shutdown", `shutdown ${q(udid)}`).pipe(
			Effect.ignore,
			Effect.andThen(simctl("delete", `delete ${q(udid)}`)),
			Effect.ignore
		)

	const cleanupOrphans = Effect.gen(function* () {
		if (process.platform !== "darwin") {
			return 0
		}
		const list = JSON.parse(yield* simctl("list", "list -j devices")) as {
			devices: Record<string, ReadonlyArray<{ name: string; udid: string }>>
		}
		const orphans = Object.values(list.devices)
			.flat()
			.filter((d) => {
				const m = NAME.exec(d.name)
				return m !== null && !ownerAlive(Number(m[2]))
			})
		yield* Effect.forEach(orphans, (d) => deleteSimulator(d.udid), { discard: true })
		return orphans.length
	}).pipe(Effect.withSpan("DeviceComputerProvider.cleanupOrphans"))

	const create = Effect.fn("DeviceComputerProvider.create")(function* (spec: ComputerSpec) {
		const device = spec.device
		if (device === undefined) {
			return yield* new DeviceError({ message: "no device in the spec", operation: "create" })
		}
		const argent = yield* loadArgent
		const artifacts = resolve(spec.artifactsDir)
		const workDir = join(tmpdir(), `witness-${spec.runId}`)
		const app = join(workDir, "app")
		yield* Effect.tryPromise({
			catch: fail("workDir"),
			try: async () => {
				await mkdir(artifacts, { recursive: true })
				await mkdir(app, { recursive: true })
				if (!(await stat(device.app)).isDirectory()) {
					throw new Error(`${device.app} is not an app bundle`)
				}
			},
		})
		if (!spec.keep) {
			yield* Effect.addFinalizer(() => Effect.promise(() => rm(workDir, { force: true, recursive: true })))
		}

		// 1. A fresh simulator with the app on it.
		const runtimes = JSON.parse(yield* simctl("list", "list -j runtimes")).runtimes as SimRuntime[]
		const picked = pickSimulator(runtimes, device)
		if (typeof picked === "string") {
			return yield* new DeviceError({ message: picked, operation: "create" })
		}
		const udid = yield* simctl(
			"create",
			`create ${q(`witness-${spec.runId}-${process.pid}`)} ${q(picked.type)} ${q(picked.runtime)}`
		)
		yield* Effect.addFinalizer(() =>
			spec.keep
				? Effect.logInfo("simulator kept", { cleanup: `xcrun simctl delete ${udid}`, udid })
				: deleteSimulator(udid)
		)
		// With simslim installed, the first boot comes up without the background daemons
		// a test run doesn't need (about a third of the memory), except the categories
		// the app or this change needs. Without it, or if it fails, `bootstatus -b` boots stock.
		const except = device.services.length ? ` --except ${q(device.services.join(","))}` : ""
		yield* host("simslim", `command -v simslim >/dev/null && simslim on ${q(udid)}${except}`, 300_000).pipe(
			Effect.tapError((e) => Effect.logInfo("booting without simslim", { reason: e.message.slice(0, 200) })),
			Effect.ignore
		)
		yield* simctl("bootstatus", `bootstatus ${q(udid)} -b`, 300_000)
		yield* simctl("install", `install ${q(udid)} ${q(device.app)}`, 300_000)

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
		const read = (file: string) => Effect.tryPromise({ catch: fail("screenshot"), try: () => readFile(file) })

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

		/** Answers iOS's "Open in <app>?" prompt that a deep link raises; false when none came within 5 s. */
		const confirmOpen = Effect.gen(function* () {
			for (let i = 0; i < 10; i++) {
				const { description } = yield* argent.call<{ description: string }>("describe", { udid })
				const tree = parseScreenTree(description, screen)
				const open = tree.elements.find((e) => e.tag === "AXButton" && e.name === "Open")
				if (open && /^Open in /m.test(tree.text)) {
					yield* argent.call("gesture-tap", { udid, x: open.x / screen.width, y: open.y / screen.height })
					return true
				}
				yield* sleep(500)
			}
			return false
		})

		let recording: Option.Option<{ proc: ChildProcess; startedAt: number; file: string }> = Option.none()
		const stopRecording = Effect.gen(function* () {
			if (Option.isNone(recording)) {
				return yield* new DeviceError({ message: "not recording", operation: "stopRecording" })
			}
			const { file, proc, startedAt } = recording.value
			recording = Option.none()
			const stoppedAt = Date.now()
			yield* Effect.promise(
				() =>
					new Promise<void>((done) => {
						const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
						proc.once("exit", () => {
							clearTimeout(timer)
							done()
						})
						proc.kill("SIGINT")
					})
			)
			// simctl writes a frame only when the screen changes and stops at the last
			// change; a constant 30 fps that holds the last frame keeps step times true.
			const duration = (stoppedAt - startedAt) / 1000
			const mp4 = join(artifacts, "raw.mp4")
			yield* host(
				"remux",
				`ffmpeg -hide_banner -loglevel error -y -i ${q(file)} -vf ${q(`fps=30,tpad=stop_mode=clone:stop_duration=${duration}`)} -t ${duration} -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -movflags +faststart ${q(mp4)}`,
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
					// Right after boot iOS can drop a deep link, so it is sent again until its
					// "Open in" prompt shows. (Launching the app first does not help: a dev build
					// still starting up ignores the link.)
					for (let attempt = 1; ; attempt++) {
						const opened = yield* argent.call("open-url", { udid, url }).pipe(Effect.result)
						if (opened._tag === "Failure") {
							return { at, error: opened.failure.message, status: null, url }
						}
						if ((yield* confirmOpen) || attempt === 3) {
							break
						}
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
					catch: fail("putArchive"),
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
				const file = join(artifacts, "raw.simctl.mp4")
				const proc = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], {
					stdio: ["ignore", "ignore", "pipe"],
				})
				const startedAt = yield* Effect.tryPromise({
					catch: fail("startRecording"),
					try: () =>
						new Promise<number>((done, reject) => {
							let err = ""
							const timer = setTimeout(() => {
								proc.kill("SIGKILL")
								reject(new Error(`simctl recordVideo did not start: ${err.trim()}`))
							}, 15_000)
							proc.stderr?.on("data", (chunk: Buffer) => {
								err += chunk.toString()
								if (err.includes("Recording started")) {
									clearTimeout(timer)
									done(Date.now())
								}
							})
							proc.once("exit", (code) => {
								clearTimeout(timer)
								reject(new Error(`simctl recordVideo exited ${code}: ${err.trim()}`))
							})
						}),
				})
				recording = Option.some({ file, proc, startedAt })
				return { mkv: file, startedAt }
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
