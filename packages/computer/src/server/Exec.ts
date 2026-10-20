// Shell commands as the computer's non-root user: foreground (timeout + output cap)
// or background (the app under test), which lives until the control server stops.
import { Context, Duration, Effect, Fiber, Layer, Option, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { ExecRequest, ExecResult } from "../protocol.ts"
import { Artifacts } from "./Artifacts.ts"
import { childEnv } from "./Browser.ts"
import type { ArtifactPathError } from "./Errors.ts"
import { ExecError } from "./Errors.ts"
import { collectCapped } from "./Proc.ts"

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export class Exec extends Context.Service<
	Exec,
	{
		run(request: ExecRequest): Effect.Effect<ExecResult, ExecError | ArtifactPathError>
	}
>()("witness/computer/server/Exec") {
	static readonly layer = Layer.effect(
		Exec,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const artifacts = yield* Artifacts
			// Background processes belong to the server, not to the request that started them.
			const serverScope = yield* Effect.scope
			const failed = (e: unknown) => new ExecError({ message: e instanceof Error ? e.message : String(e) })

			const command = (r: ExecRequest, cmd: string, background: boolean) =>
				ChildProcess.make("bash", ["-lc", cmd], {
					cwd: r.cwd ?? "/home/qa",
					env: { ...childEnv(), ...r.env },
					extendEnv: false,
					detached: true,
					stdin: "ignore",
					...(background ? { stdout: "ignore" as const, stderr: "ignore" as const } : {}),
				})

			const background = Effect.fnUntraced(function* (r: ExecRequest) {
				const log = r.log ? yield* artifacts.resolve(r.log) : undefined
				const cmd = log ? `{ ${r.cmd} ; } >> ${shQuote(log)} 2>&1` : r.cmd
				const handle = yield* spawner.spawn(command(r, cmd, true)).pipe(Scope.provide(serverScope), Effect.mapError(failed))
				return { code: null, timed_out: false, truncated: false, stdout: "", stderr: "", pid: Number(handle.pid) } satisfies ExecResult
			})

			const foreground = Effect.fnUntraced(function* (r: ExecRequest) {
				const max = r.max_bytes ?? 1_000_000
				const handle = yield* spawner.spawn(command(r, r.cmd, false)).pipe(Effect.mapError(failed))
				const out = yield* Effect.forkChild(collectCapped(handle.stdout, max))
				const err = yield* Effect.forkChild(collectCapped(handle.stderr, max))
				const code = yield* handle.exitCode.pipe(Effect.timeoutOption(Duration.millis(r.timeout_ms ?? 30_000)), Effect.mapError(failed))
				if (Option.isNone(code)) {
					yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
				}
				const stdout = yield* Fiber.join(out).pipe(Effect.mapError(failed))
				const stderr = yield* Fiber.join(err).pipe(Effect.mapError(failed))
				return {
					code: Option.match(code, { onNone: () => null, onSome: (c) => Number(c) }),
					timed_out: Option.isNone(code),
					truncated: stdout.truncated || stderr.truncated,
					stdout: stdout.text,
					stderr: stderr.text,
				} satisfies ExecResult
			}, Effect.scoped)

			const run = Effect.fn("Exec.run")(function* (r: ExecRequest) {
				return yield* r.background ? background(r) : foreground(r)
			})

			return Exec.of({ run })
		})
	)
}
