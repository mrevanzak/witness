// iOS: a fresh simulator per run (simctl), slimmed by simslim when it's installed,
// recorded with `simctl io recordVideo` (argent's recorder stops at 10 minutes).
import { spawn } from "node:child_process"
import type { DeviceConfig } from "@witness/domain"
import { Effect } from "effect"
import { DeviceError } from "../computer.ts"
import type { Argent } from "./argent.ts"
import { type Device, deviceName, failWith, host, isOrphan, onPath, optional, q, sleep } from "./host.ts"
import { parseScreenTree } from "./screen-tree.ts"

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

const simctl = (operation: string, args: string, timeoutMs?: number) =>
	host(operation, `xcrun simctl ${args}`, timeoutMs)

/** Shuts down and deletes a simulator; never fails. */
const deleteSimulator = (udid: string) =>
	simctl("shutdown", `shutdown ${q(udid)}`).pipe(
		Effect.ignore,
		Effect.andThen(simctl("delete", `delete ${q(udid)}`)),
		Effect.ignore
	)

/** Deletes simulators left by witness runs whose process has exited. */
export const cleanupSimulators = Effect.gen(function* () {
	if (process.platform !== "darwin") {
		return 0
	}
	const list = JSON.parse(yield* simctl("list", "list -j devices")) as {
		devices: Record<string, ReadonlyArray<{ name: string; udid: string }>>
	}
	const orphans = Object.values(list.devices)
		.flat()
		.filter((d) => isOrphan(d.name))
	yield* Effect.forEach(orphans, (d) => deleteSimulator(d.udid), { discard: true })
	return orphans.length
})

/** A fresh simulator with the app installed, deleted when the scope closes (unless `keep`). */
export const createSimulator = Effect.fn("createSimulator")(function* (
	runId: string,
	device: DeviceConfig & { readonly services: readonly string[] },
	keep: boolean,
	argent: Argent
) {
	const runtimes = JSON.parse(yield* simctl("list", "list -j runtimes")).runtimes as SimRuntime[]
	const picked = pickSimulator(runtimes, device)
	if (typeof picked === "string") {
		return yield* new DeviceError({ message: picked, operation: "create" })
	}
	const udid = yield* simctl("create", `create ${q(deviceName(runId))} ${q(picked.type)} ${q(picked.runtime)}`)
	yield* Effect.addFinalizer(() =>
		keep ? Effect.logInfo("simulator kept", { cleanup: `xcrun simctl delete ${udid}`, udid }) : deleteSimulator(udid)
	)
	// With simslim, the first boot comes up without the background services a test run
	// doesn't need (about a third of the memory), except the categories the app or this
	// change needs. Without it, or if it fails, `bootstatus -b` boots stock.
	if (yield* onPath("simslim")) {
		const except = device.services.length ? ` --except ${q(device.services.join(","))}` : ""
		yield* host("simslim", `simslim on ${q(udid)}${except}`, 300_000).pipe(optional("booting without simslim"))
	}
	yield* simctl("bootstatus", `bootstatus ${q(udid)} -b`, 300_000)
	yield* simctl("install", `install ${q(udid)} ${q(device.app)}`, 300_000)

	/** Answers iOS's "Open in <app>?" prompt that a deep link raises; false when none came within 5 s. */
	const confirmOpen = Effect.gen(function* () {
		const unit = { height: 1000, width: 1000 }
		for (let i = 0; i < 10; i++) {
			const { description } = yield* argent.call<{ description: string }>("describe", { udid })
			const tree = parseScreenTree(description, unit)
			const open = tree.elements.find((e) => e.tag === "AXButton" && e.name === "Open")
			if (open && /^Open in /m.test(tree.text)) {
				yield* argent.call("gesture-tap", { udid, x: open.x / unit.width, y: open.y / unit.height })
				return true
			}
			yield* sleep(500)
		}
		return false
	})

	const record = Effect.fnUntraced(function* (file: string) {
		const proc = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], {
			stdio: ["ignore", "ignore", "pipe"],
		})
		const startedAt = yield* Effect.tryPromise({
			catch: failWith("startRecording"),
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
		// SIGINT makes simctl write the file; SIGKILL only if it hangs.
		const stop = Effect.promise(
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
		return { startedAt, stop }
	})

	return {
		id: udid,
		// Right after boot iOS can drop a deep link, so it is sent again until its "Open in"
		// prompt shows. (Launching the app first does not help: a dev build still starting
		// up ignores the link.)
		openLink: (url) =>
			Effect.gen(function* () {
				for (let attempt = 1; attempt <= 3; attempt++) {
					yield* argent.call("open-url", { udid, url })
					if (yield* confirmOpen) {
						return
					}
				}
			}),
		record,
		videoExt: "mp4",
	} satisfies Device
})
