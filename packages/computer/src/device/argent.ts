// argent drives the simulator (touch, keyboard, screenshots, the accessibility
// tree). Witness uses the argent install on the user's PATH through its JS client,
// so it needs no copy of its own, and fails with how to install it when missing.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schedule } from "effect"
import { DeviceError } from "../computer.ts"
import { messageOf } from "../message.ts"

export type Argent = {
	call: <T>(tool: string, args: Record<string, unknown>) => Effect.Effect<T, DeviceError>
}

type ArgentClient = {
	callTool: (name: string, args: Record<string, unknown>) => Promise<{ readonly data: unknown }>
}

/** A busy emulator drops off adb for a moment; the next try reaches it. */
const OFFLINE = /device offline|device '.*' not found/
/**
 * Tools that only look, or open a link, so a second try does no harm. A tap, swipe or
 * keystroke may have landed before the connection dropped; repeating it would act twice.
 */
const RETRY_SAFE = new Set(["await-screen-idle", "describe", "open-url", "screenshot"])

/** Whether a failed `tool` call is tried again: only a look, after the device dropped off for a moment. */
export const retriable = (tool: string, message: string) => RETRY_SAFE.has(tool) && OFFLINE.test(message)

const PACKAGE = "@swmansion/argent"
const INSTALL = "install argent (`npm install -g @swmansion/argent`), then run the device app again"

/** The argent package root behind the `argent` command on PATH. */
const packageRoot = (): string => {
	const bin = execFileSync("sh", ["-c", "command -v argent"], { encoding: "utf8" }).trim()
	let dir = dirname(realpathSync(bin))
	for (;;) {
		const manifest = join(dir, "package.json")
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE) {
			return dir
		}
		const up = dirname(dir)
		if (up === dir) {
			throw new Error(`${bin} is not part of ${PACKAGE}`)
		}
		dir = up
	}
}

/** Loads argent's client; fails with install instructions when argent is not on PATH. */
export const loadArgent = Effect.tryPromise({
	catch: (e) => new DeviceError({ message: `argent not found (${messageOf(e)}); ${INSTALL}`, operation: "argent" }),
	try: async () => {
		const mod = (await import(pathToFileURL(join(packageRoot(), "dist", "client.js")).href)) as {
			createArgentClient: () => ArgentClient
		}
		return mod.createArgentClient()
	},
}).pipe(
	Effect.map(
		(client): Argent => ({
			call: <T>(tool: string, args: Record<string, unknown>) =>
				Effect.tryPromise({
					catch: (e) => new DeviceError({ message: messageOf(e), operation: tool }),
					try: () => client.callTool(tool, args).then((r) => r.data as T),
				}).pipe(
					Effect.retry({
						schedule: Schedule.spaced("1 second"),
						times: 3,
						while: (e) => retriable(tool, e.message),
					})
				),
		})
	)
)
