// Shell commands for the app under test: `run` to completion (timeout + output
// cap), or `spawn` detached (the app's server), living until the scope that made
// the Exec closes (the control server, or a device run on the host).
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
import { childEnv, collectCapped } from "./proc.ts"

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

type ExecApi = {
	run: (request: ExecRequest) => Effect.Effect<ExecResult, ServerError>
	spawn: (request: SpawnRequest) => Effect.Effect<SpawnResult, ServerError | ArtifactPathError>
}

export type ExecOptions = {
	/** Working directory of a request that names none. */
	readonly cwd: string
	/** Environment of every command (a request's `env` is merged over it). */
	readonly env: Readonly<Record<string, string>>
	/** Spawned processes outlive the scope (a kept run) instead of stopping with it. */
	readonly keepSpawned: boolean
	/** The shell and its flag that take the command, e.g. `["bash", "-lc"]`. */
	readonly shell: readonly [string, string]
}

/** An Exec whose spawned processes belong to the surrounding scope, not to the request that started them. */
export const makeExec = (o: ExecOptions) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const artifacts = yield* Artifacts
		const owner = yield* Effect.scope
		const failed = (e: unknown) => new ServerError({ message: messageOf(e) })

		const command = (
			r: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
			cmd: string,
			detach: boolean
		) =>
			ChildProcess.make(o.shell[0], [o.shell[1], cmd], {
				cwd: r.cwd ?? o.cwd,
				detached: true,
				env: { ...o.env, ...r.env },
				extendEnv: false,
				stdin: "ignore",
				...(detach ? { stderr: "ignore" as const, stdout: "ignore" as const } : {}),
			})

		const spawn = Effect.fn("Exec.spawn")(function* (r: SpawnRequest) {
			const log = yield* artifacts.resolve(r.log)
			const handle = yield* spawner
				.spawn(command(r, `{ ${r.cmd} ; } >> ${shQuote(log)} 2>&1`, true))
				.pipe(Scope.provide(owner), Effect.mapError(failed))
			if (o.keepSpawned) {
				// Unreferenced, it survives the scope and does not hold this process open.
				yield* handle.unref.pipe(Effect.mapError(failed))
			}
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

		return { run, spawn } satisfies ExecApi
	})

export class Exec extends Context.Service<Exec, ExecApi>()("witness/computer/server/Exec") {
	static readonly layer = Layer.effect(
		Exec,
		makeExec({ cwd: "/home/qa", env: childEnv(), keepSpawned: false, shell: ["bash", "-lc"] })
	)
}
