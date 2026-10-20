// Shell commands as the computer's non-root user: `run` to completion (timeout +
// output cap), or `spawn` detached (the app under test), living until the control
// server stops.
import { Context, Duration, Effect, Fiber, Layer, Option, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { messageOf } from "../message.ts"
import {
	type ArtifactPathError,
	type ExecRequest,
	type ExecResult,
	ServerError,
	type SpawnRequest,
	type SpawnResult,
} from "../protocol.ts"
import { Artifacts } from "./artifacts.ts"
import { childEnv } from "./browser.ts"
import { collectCapped } from "./proc.ts"

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export class Exec extends Context.Service<
	Exec,
	{
		run: (request: ExecRequest) => Effect.Effect<ExecResult, ServerError>
		spawn: (request: SpawnRequest) => Effect.Effect<SpawnResult, ServerError | ArtifactPathError>
	}
>()("witness/computer/server/Exec") {
	static readonly layer = Layer.effect(
		Exec,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const artifacts = yield* Artifacts
			// Spawned processes belong to the server, not to the request that started them.
			const serverScope = yield* Effect.scope
			const failed = (e: unknown) => new ServerError({ message: messageOf(e) })

			const command = (
				r: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
				cmd: string,
				detach: boolean
			) =>
				ChildProcess.make("bash", ["-lc", cmd], {
					cwd: r.cwd ?? "/home/qa",
					detached: true,
					env: { ...childEnv(), ...r.env },
					extendEnv: false,
					stdin: "ignore",
					...(detach ? { stderr: "ignore" as const, stdout: "ignore" as const } : {}),
				})

			const spawn = Effect.fn("Exec.spawn")(function* (r: SpawnRequest) {
				const log = yield* artifacts.resolve(r.log)
				const handle = yield* spawner
					.spawn(command(r, `{ ${r.cmd} ; } >> ${shQuote(log)} 2>&1`, true))
					.pipe(Scope.provide(serverScope), Effect.mapError(failed))
				return { pid: Number(handle.pid) }
			})

			const run = Effect.fn("Exec.run")(function* (r: ExecRequest) {
				const max = r.max_bytes ?? 1_000_000
				const handle = yield* spawner.spawn(command(r, r.cmd, false)).pipe(Effect.mapError(failed))
				const out = yield* Effect.forkChild(collectCapped(handle.stdout, max))
				const err = yield* Effect.forkChild(collectCapped(handle.stderr, max))
				const code = yield* handle.exitCode.pipe(
					Effect.timeoutOption(Duration.millis(r.timeout_ms ?? 30_000)),
					Effect.mapError(failed)
				)
				if (Option.isNone(code)) {
					yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
				}
				const stdout = yield* Fiber.join(out).pipe(Effect.mapError(failed))
				const stderr = yield* Fiber.join(err).pipe(Effect.mapError(failed))
				return {
					code: Option.match(code, { onNone: () => null, onSome: (c) => Number(c) }),
					stderr: stderr.text,
					stdout: stdout.text,
					timed_out: Option.isNone(code),
					truncated: stdout.truncated || stderr.truncated,
				} satisfies ExecResult
			}, Effect.scoped)

			return Exec.of({ run, spawn })
		})
	)
}
