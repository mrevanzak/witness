// iOS: a fresh simulator per run (simctl), slimmed by simslim when it's installed,
// recorded with `simctl io recordVideo` (argent's recorder stops at 10 minutes).
import { Effect, Option, Scope, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { DeviceError } from "../computer.ts"
import { type Backend, type Device, deviceName, failWith, type Host, isOrphan, optional, q, waitUntil } from "./host.ts"
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

/** Picks the runtime and device type: the configured ones, or the newest iOS and its newest iPhone; throws why not. */
export const pickSimulator = (
	runtimes: readonly SimRuntime[],
	want: { readonly runtime?: string; readonly type?: string }
): { runtime: string; type: string } => {
	const ios = runtimes
		.filter((r) => r.isAvailable && (r.platform ?? r.name.split(" ")[0]) === "iOS")
		.sort((a, b) => (versionKey(a.version).join() < versionKey(b.version).join() ? -1 : 1))
	const runtime = want.runtime
		? ios.find((r) => [r.name, r.identifier, `iOS ${r.version}`, r.version].includes(want.runtime ?? ""))
		: ios.at(-1)
	if (!runtime) {
		throw new Error(
			want.runtime
				? `no available simulator runtime ${want.runtime}; installed: ${ios.map((r) => r.name).join(", ") || "none"}`
				: "no iOS simulator runtime is installed (Xcode > Settings > Components)"
		)
	}
	const types = runtime.supportedDeviceTypes ?? []
	const type = want.type
		? types.find((t) => t.name === want.type || t.identifier === want.type)
		: types.filter((t) => t.productFamily === "iPhone").at(-1)
	if (!type) {
		throw new Error(
			want.type
				? `${runtime.name} has no device type ${want.type}; e.g. ${types
						.filter((t) => t.productFamily === "iPhone")
						.map((t) => t.name)
						.join(", ")}`
				: `${runtime.name} supports no iPhone`
		)
	}
	return { runtime: runtime.identifier, type: type.identifier }
}

/** JSON a command printed. */
const parseJson = <T>(operation: string, text: string) =>
	Effect.try({ catch: failWith(operation), try: () => JSON.parse(text) as T })

export const makeIos = (host: Host): Backend => {
	const simctl = (operation: string, args: string, timeoutMs?: number) =>
		host.run(operation, `xcrun simctl ${args}`, timeoutMs)

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
		const list = yield* parseJson<{ devices: Record<string, ReadonlyArray<{ name: string; udid: string }>> }>(
			"list",
			yield* simctl("list", "list -j devices")
		)
		const orphans = Object.values(list.devices)
			.flat()
			.filter((d) => isOrphan(d.name))
		yield* Effect.forEach(orphans, (d) => deleteSimulator(d.udid), { discard: true })
		return orphans.length
	}).pipe(Effect.orElseSucceed(() => 0))

	const create: Backend["create"] = Effect.fn("createSimulator")(function* (runId, device, argent) {
		const { runtimes } = yield* parseJson<{ runtimes: SimRuntime[] }>("list", yield* simctl("list", "list -j runtimes"))
		const picked = yield* Effect.try({ catch: failWith("create"), try: () => pickSimulator(runtimes, device) })
		const udid = yield* simctl("create", `create ${q(deviceName(runId))} ${q(picked.type)} ${q(picked.runtime)}`)
		yield* Effect.addFinalizer(() => deleteSimulator(udid))
		// With simslim, the first boot comes up without the background services a test run
		// doesn't need (about a third of the memory), except the categories the app or this
		// change needs. Without it, or if it fails, `bootstatus -b` boots stock.
		if (yield* host.onPath("simslim")) {
			const except = device.services.length ? ` --except ${q(device.services.join(","))}` : ""
			yield* host.run("simslim", `simslim on ${q(udid)}${except}`, 300_000).pipe(optional("booting without simslim"))
		}
		yield* simctl("bootstatus", `bootstatus ${q(udid)} -b`, 300_000)
		yield* simctl("install", `install ${q(udid)} ${q(device.app)}`, 300_000)

		/** Taps "Open" on iOS's "Open in <app>?" prompt that a deep link raises; false if it is not up. */
		const unit = { height: 1000, width: 1000 }
		const answerPrompt = argent.call<{ description: string }>("describe", { udid }).pipe(
			Effect.flatMap(({ description }) => {
				const tree = parseScreenTree(description, unit)
				const open = tree.elements.find((e) => e.tag === "AXButton" && e.name === "Open")
				return open && /^Open in /m.test(tree.text)
					? argent.call("gesture-tap", { udid, x: open.x / unit.width, y: open.y / unit.height }).pipe(Effect.as(true))
					: Effect.succeed(false)
			})
		)

		// Recordings stop with the device's scope, if nothing stopped them before.
		const scope = yield* Effect.scope
		const record = Effect.fnUntraced(function* (file: string) {
			const proc = yield* host
				.spawn(
					"startRecording",
					ChildProcess.make("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], {
						// SIGINT makes simctl write the file; SIGKILL only if it hangs.
						forceKillAfter: "20 seconds",
						killSignal: "SIGINT",
						stdin: "ignore",
						stdout: "ignore",
					})
				)
				.pipe(Scope.provide(scope))
			// simctl says on stderr once it has the first frame.
			const said = yield* proc.stderr.pipe(
				Stream.decodeText(),
				Stream.scan(
					() => "",
					(all, text) => all + text
				),
				Stream.takeUntil((all) => all.includes("Recording started")),
				Stream.runLast,
				Effect.timeoutOption("15 seconds"),
				Effect.map((all) => Option.getOrElse(Option.flatten(all), () => "")),
				Effect.mapError(failWith("startRecording"))
			)
			if (!said.includes("Recording started")) {
				yield* proc.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
				return yield* new DeviceError({
					message: `simctl recordVideo did not start: ${said.trim()}`,
					operation: "startRecording",
				})
			}
			return {
				startedAt: Date.now(),
				stop: proc
					.kill({ forceKillAfter: "20 seconds", killSignal: "SIGINT" })
					.pipe(Effect.mapError(failWith("stopRecording"))),
			}
		})

		return {
			cleanup: `xcrun simctl delete ${udid}`,
			id: udid,
			// Right after boot iOS can drop a deep link, so it is sent again (three tries) until its
			// "Open in" prompt shows. (Launching the app first does not help: a dev build still
			// starting up ignores the link.)
			openLink: (url) =>
				argent
					.call("open-url", { udid, url })
					.pipe(
						Effect.andThen(waitUntil(answerPrompt, "500 millis", "5 seconds")),
						Effect.repeat({ times: 2, until: (opened) => opened }),
						Effect.asVoid
					),
			record,
			videoExt: "mp4",
		} satisfies Device
	})

	return { cleanupOrphans, create }
}
