// Boots the app under test inside a computer: source -> services -> setup ->
// start (stdout/stderr -> /artifacts/app.log) -> health -> Chromium on the URL.
// A boot failure is a typed AppBootFailed with the log tail; the verifier turns it
// into a `blocked` verdict rather than a crash.
import type { Computer } from "@witness/computer"
import type { WitnessConfig } from "@witness/domain"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { CurrentRun } from "./CurrentRun.ts"
import { chownTar } from "./tar.ts"

export const APP_DIR = "/home/qa/app"
const QA = { uid: 1000, gid: 1000, user: "qa", group: "qa" }

export const BootStage = Schema.Literals(["upload", "services", "setup", "start", "health"])
export type BootStage = typeof BootStage.Type

export class AppBootFailed extends Schema.TaggedError<AppBootFailed>()("AppBootFailed", {
	stage: BootStage,
	message: Schema.String,
	logTail: Schema.String,
}) {}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export class AppBooter extends Context.Service<
	AppBooter,
	{
		/** Returns the boot time in ms. `staged` holds verifier-side files (already owned by qa). */
		boot(computer: Computer, config: WitnessConfig, source: Uint8Array, staged: Uint8Array | undefined): Effect.Effect<number, AppBootFailed>
	}
>()("witness/orchestrator/AppBooter") {
	static readonly layer = Layer.effect(
		AppBooter,
		Effect.gen(function* () {
			const run = yield* CurrentRun

			const boot = Effect.fn("AppBooter.boot")(function* (computer: Computer, config: WitnessConfig, source: Uint8Array, staged: Uint8Array | undefined) {
				const started = yield* Clock.currentTimeMillis
				const failWith = (stage: BootStage, logFile?: string) => (message: string) =>
					Effect.gen(function* () {
						const logTail = logFile ? yield* computer.logs(logFile, 60).pipe(Effect.orElseSucceed(() => "")) : ""
						yield* run.log("boot.blocked", { stage, message })
						return yield* new AppBootFailed({ stage, message, logTail })
					})
				const asBoot = (stage: BootStage, logFile?: string) => (e: { readonly message: string }) => failWith(stage, logFile)(e.message)

				// 1. Source (exact commit, owned by qa) and staged verifier-side files.
				yield* computer.putArchive(chownTar(source, QA), APP_DIR).pipe(Effect.catch(asBoot("upload")))
				if (staged) yield* computer.putArchive(staged, APP_DIR).pipe(Effect.catch(asBoot("upload")))
				const check = yield* computer.exec({ cmd: `test -w ${APP_DIR} && ls -A ${APP_DIR}` }).pipe(Effect.catch(asBoot("upload")))
				if (check.code !== 0) return yield* failWith("upload")(`source not writable in ${APP_DIR}: ${check.stderr}`)
				yield* run.log("boot.source", { files: check.stdout.split("\n").filter(Boolean).length })

				// 2. Sibling services on the run network, reachable by name.
				for (const [name, svc] of Object.entries(config.services)) {
					yield* computer.startService(name, svc).pipe(Effect.catch((e) => failWith("services")(`service ${name} (${svc.image}) failed to start: ${e.message}`)))
					if (svc.port) {
						const wait = yield* computer
							.exec({ cmd: `for i in $(seq 1 120); do (echo > /dev/tcp/${name}/${svc.port}) 2>/dev/null && exit 0; sleep 0.5; done; exit 1`, timeout_ms: 70_000 })
							.pipe(Effect.catch(asBoot("services")))
						if (wait.code !== 0) return yield* failWith("services")(`service ${name} never accepted connections on ${svc.port}`)
					}
					yield* run.log("boot.service", { name, image: svc.image, port: svc.port })
				}

				// 3. Setup commands, each with the remaining share of the setup budget.
				const deadline = started + config.timeouts.setupSec * 1000
				for (const cmd of config.setup) {
					const remaining = deadline - (yield* Clock.currentTimeMillis)
					if (remaining <= 0) return yield* failWith("setup", "setup.log")(`setup exceeded ${config.timeouts.setupSec}s`)
					const t = yield* Clock.currentTimeMillis
					const res = yield* computer
						.exec({ cmd: `echo "\\$ "${sh(cmd)} >> /artifacts/setup.log; { ${cmd} ; } >> /artifacts/setup.log 2>&1`, cwd: APP_DIR, env: config.env, timeout_ms: remaining })
						.pipe(Effect.catch(asBoot("setup", "setup.log")))
					if (res.timed_out) return yield* failWith("setup", "setup.log")(`setup command timed out: ${cmd}`)
					if (res.code !== 0) return yield* failWith("setup", "setup.log")(`setup command exited ${res.code}: ${cmd}`)
					yield* run.log("boot.setup", { cmd, ms: (yield* Clock.currentTimeMillis) - t })
				}

				// 4. Start in the background, then 5. wait for health while it stays alive.
				const start = yield* computer.exec({ cmd: `exec ${config.start}`, cwd: APP_DIR, env: config.env, background: true, log: "app.log" }).pipe(Effect.catch(asBoot("start", "app.log")))
				yield* run.log("boot.start", { cmd: config.start, pid: start.pid })
				const bootDeadline = (yield* Clock.currentTimeMillis) + config.timeouts.bootSec * 1000
				let last = ""
				while ((yield* Clock.currentTimeMillis) < bootDeadline) {
					const probe = yield* computer
						.exec({ cmd: `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ${sh(config.health)}`, timeout_ms: 10_000 })
						.pipe(Effect.catch(asBoot("health", "app.log")))
					last = probe.stdout.trim() || probe.stderr.trim()
					const code = Number(probe.stdout.trim())
					if (code >= 200 && code < 400) {
						const nav = yield* computer.navigate(config.url, 60_000).pipe(Effect.catch(asBoot("health", "app.log")))
						if (nav.error) return yield* failWith("health", "app.log")(`Chromium could not open ${config.url}: ${nav.error}`)
						const ms = (yield* Clock.currentTimeMillis) - started
						yield* run.log("boot.ok", { url: nav.url, status: nav.status, ms })
						return ms
					}
					const alive = yield* computer.exec({ cmd: `kill -0 ${start.pid}` }).pipe(Effect.catch(asBoot("start", "app.log")))
					if (alive.code !== 0) return yield* failWith("start", "app.log")(`start command exited before ${config.health} responded`)
					yield* Effect.sleep("1 second")
				}
				return yield* failWith("health", "app.log")(`${config.health} not healthy after ${config.timeouts.bootSec}s (last: ${last})`)
			})

			return AppBooter.of({ boot })
		})
	)
}
