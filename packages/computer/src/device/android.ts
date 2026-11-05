// Android: a fresh AVD per run (avdmanager), booted headless, slimmed by avdslim when
// it's installed (`tune-avd` before the boot, `on` after it), and recorded with the
// emulator's own recorder (up to 30 minutes; `adb shell screenrecord` stops at 3).
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DeviceConfig } from "@witness/domain"
import { Effect } from "effect"
import { DeviceError } from "../computer.ts"
import type { Argent } from "./argent.ts"
import { type Device, deviceName, failWith, host, isOrphan, onPath, optional, q, sleep, stopGroup } from "./host.ts"

const sdk = () => process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk")
const avdmanager = () => q(join(sdk(), "cmdline-tools/latest/bin/avdmanager"))
const adb = () => q(join(sdk(), "platform-tools/adb"))
const hostAbi = () => (process.arch === "arm64" ? "arm64-v8a" : "x86_64")

/** An installed system image, e.g. `system-images;android-35;google_apis;arm64-v8a`. */
type SystemImage = { readonly api: number; readonly tag: string; readonly abi: string; readonly path: string }

/**
 * Picks the system image: the configured one (`android-35`, `android-35;google_apis` or a
 * full package path), else the newest. Google APIs images beat Google Play ones, which
 * run Play Store updaters and block `adb root`.
 */
export const pickImage = (images: readonly SystemImage[], want: string | undefined): string => {
	const parts = (want ?? "")
		.replace(/^system-images;/, "")
		.split(";")
		.filter(Boolean)
	const ranked = images
		.filter((i) => i.abi === hostAbi())
		.filter((i) => (parts[0] ? `android-${i.api}` === parts[0] : true))
		.filter((i) => (parts[1] ? i.tag === parts[1] : i.tag === "google_apis" || i.tag === "google_apis_playstore"))
		.sort((a, b) => a.api - b.api || (a.tag === "google_apis" ? 1 : 0) - (b.tag === "google_apis" ? 1 : 0))
	const best = ranked.at(-1)
	if (!best) {
		throw new Error(
			`no installed ${hostAbi()} system image${want ? ` matching ${want}` : ""}; installed: ${images.map((i) => i.path).join(", ") || "none"} (install one with sdkmanager)`
		)
	}
	return best.path
}

/** The newest `pixel_N` device profile, when none is configured. */
export const pickDeviceType = (ids: readonly string[]): string =>
	ids
		.filter((id) => /^pixel_\d+$/.test(id))
		.sort((a, b) => Number(a.replace("pixel_", "")) - Number(b.replace("pixel_", "")))
		.at(-1) ?? "pixel"

/** Installed system images (folders with a system.img). */
const installedImages = host("images", `cd ${q(join(sdk(), "system-images"))} && ls -d */*/*/system.img`).pipe(
	Effect.map((out) =>
		out
			.split("\n")
			.filter(Boolean)
			.flatMap((line): SystemImage[] => {
				const [platform = "", tag = "", abi = ""] = line.split("/")
				const api = Number(platform.replace(/^android-/, ""))
				return Number.isFinite(api) ? [{ abi, api, path: `system-images;${platform};${tag};${abi}`, tag }] : []
			})
	)
)

/** A TCP port nothing listens on. */
const isFree = (port: number) =>
	new Promise<boolean>((done) => {
		const s = createServer()
		s.once("error", () => done(false))
		s.listen(port, "127.0.0.1", () => s.close(() => done(true)))
	})

/** An even console port (adb uses it and the next one) and a gRPC port, all free. */
const freePorts = Effect.promise(async () => {
	for (let port = 5560; port <= 5680; port += 2) {
		if ((await isFree(port)) && (await isFree(port + 1)) && (await isFree(port + 3000))) {
			return { console: port, grpc: port + 3000 }
		}
	}
	throw new Error("no free emulator port between 5560 and 5680")
})

const deleteAvd = (name: string) => host("deleteAvd", `${avdmanager()} delete avd -n ${q(name)}`).pipe(Effect.ignore)

/** Stops emulators and deletes AVDs left by witness runs whose process has exited. */
export const cleanupEmulators = Effect.gen(function* () {
	const avdDir = join(homedir(), ".android/avd")
	const names = (yield* host("listAvds", `ls ${q(avdDir)} 2>/dev/null | sed -n 's/\\.ini$//p'`).pipe(
		Effect.orElseSucceed(() => "")
	))
		.split("\n")
		.filter(isOrphan)
	if (!names.length) {
		return 0
	}
	const serials = (yield* host("devices", `${adb()} devices | sed -n 's/^\\(emulator-[0-9]*\\).*/\\1/p'`).pipe(
		Effect.orElseSucceed(() => "")
	))
		.split("\n")
		.filter(Boolean)
	for (const serial of serials) {
		const avd = yield* host("avdName", `${adb()} -s ${serial} emu avd name | head -1`).pipe(
			Effect.orElseSucceed(() => "")
		)
		if (names.includes(avd.trim())) {
			yield* host("kill", `${adb()} -s ${serial} emu kill`).pipe(Effect.ignore)
		}
	}
	yield* sleep(2000)
	yield* Effect.forEach(names, deleteAvd, { discard: true })
	return names.length
})

/** Waits until Android reports the boot complete; fails if the emulator exits or 5 minutes pass. */
const waitForBoot = Effect.fnUntraced(function* (emulator: ChildProcess, serial: string, name: string) {
	const deadline = Date.now() + 300_000
	for (;;) {
		if (emulator.exitCode !== null) {
			return yield* new DeviceError({
				message: `the emulator exited (${emulator.exitCode}) while booting ${name}`,
				operation: "boot",
			})
		}
		const booted = yield* host("boot", `${adb()} -s ${serial} shell getprop sys.boot_completed`).pipe(
			Effect.orElseSucceed(() => "")
		)
		if (booted === "1") {
			return
		}
		if (Date.now() > deadline) {
			return yield* new DeviceError({ message: `${name} did not finish booting within 300 s`, operation: "boot" })
		}
		yield* sleep(2000)
	}
})

/** A fresh emulator with the app installed, deleted when the scope closes (unless `keep`). */
export const createEmulator = Effect.fn("createEmulator")(function* (
	runId: string,
	device: DeviceConfig & { readonly services: readonly string[] },
	keep: boolean,
	argent: Argent
) {
	const name = deviceName(runId)
	const image = yield* installedImages.pipe(
		Effect.flatMap((images) => Effect.try({ catch: failWith("create"), try: () => pickImage(images, device.runtime) }))
	)
	const type =
		device.type ??
		pickDeviceType(
			(yield* host("deviceTypes", `${avdmanager()} list device -c`).pipe(Effect.orElseSucceed(() => ""))).split("\n")
		)
	yield* host("create", `echo no | ${avdmanager()} -s create avd -n ${q(name)} -k ${q(image)} -d ${q(type)}`)
	if (!keep) {
		yield* Effect.addFinalizer(() => deleteAvd(name))
	}

	// With avdslim, the AVD gets 1536 MB and the host GPU, and boots with -lowram.
	const slim = yield* onPath("avdslim")
	if (slim) {
		yield* host("avdslim", `avdslim tune-avd ${q(name)}`).pipe(optional("booting without avdslim tuning"))
	}
	const ports = yield* freePorts
	const serial = `emulator-${ports.console}`
	// gRPC with a token is how argent reaches a headless emulator's screen and input.
	const args = [
		"-avd",
		name,
		"-port",
		String(ports.console),
		"-grpc",
		String(ports.grpc),
		"-grpc-use-token",
		"-no-window",
		"-no-snapshot",
		"-no-boot-anim",
		"-no-audio",
		"-netfast",
		"-no-metrics",
		...(slim ? ["-lowram"] : []),
	]
	const emulator = spawn(join(sdk(), "emulator/emulator"), args, { detached: true, stdio: "ignore" })
	yield* Effect.addFinalizer(() =>
		keep
			? Effect.sync(() => emulator.unref()).pipe(
					Effect.andThen(Effect.logInfo("emulator kept", { cleanup: `adb -s ${serial} emu kill`, serial }))
				)
			: host("kill", `${adb()} -s ${serial} emu kill`).pipe(
					Effect.ignore,
					Effect.andThen(Effect.promise(() => stopGroup(emulator, 10_000)))
				)
	)

	yield* waitForBoot(emulator, serial, name)
	// Turn off the background services a test run doesn't need, except the groups the app or
	// this change needs (`--skip`).
	if (slim) {
		const skip = device.services.length ? ` --skip=${q(device.services.join(","))}` : ""
		yield* host("avdslim", `avdslim on ${serial}${skip}`, 300_000).pipe(optional("running without avdslim"))
	}
	yield* host("install", `${adb()} -s ${serial} install -r ${q(device.app)}`, 300_000)
	// argent's taps reach the guest as stylus input, and Gboard answers the first one in a
	// text field with its handwriting intro instead of the keyboard.
	yield* host("stylus", `${adb()} -s ${serial} shell settings put secure stylus_handwriting_enabled 0`).pipe(
		Effect.ignore
	)

	const record = Effect.fnUntraced(function* (file: string) {
		yield* host("startRecording", `${adb()} -s ${serial} emu screenrecord start --time-limit 1800 ${q(file)}`)
		const startedAt = Date.now()
		// `stop` returns before the file is written; wait until its size settles.
		const stop = host("stopRecording", `${adb()} -s ${serial} emu screenrecord stop`).pipe(
			Effect.andThen(
				host(
					"stopRecording",
					`last=-1; for i in $(seq 1 40); do s=$(stat -f %z ${q(file)} 2>/dev/null || echo 0); [ "$s" -gt 0 ] && [ "$s" = "$last" ] && exit 0; last=$s; sleep 0.5; done; exit 1`,
					30_000
				)
			),
			Effect.asVoid
		)
		return { startedAt, stop }
	})

	return {
		id: serial,
		openLink: (url) => argent.call("open-url", { udid: serial, url }).pipe(Effect.asVoid),
		record,
		videoExt: "webm",
	} satisfies Device
})
