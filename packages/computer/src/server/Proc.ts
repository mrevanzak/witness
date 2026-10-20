// Small helpers over effect/process for the control server.
import { Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
	let off = 0
	for (const c of chunks) {
		out.set(c, off)
		off += c.length
	}
	return out
}

/** Runs a command and returns its stdout bytes; fails on a non-zero exit. */
export const runBytes = Effect.fnUntraced(function* (command: string, args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
	const chunks = yield* Stream.runCollect(handle.stdout)
	const code = yield* handle.exitCode
	if (code !== ChildProcessSpawner.ExitCode(0)) {
		return yield* Effect.fail(new Error(`${command} exited ${code}`))
	}
	return concat(chunks)
}, Effect.scoped)

/** Runs a command and returns trimmed stdout; fails on a non-zero exit. */
export const runText = (command: string, args: ReadonlyArray<string>): Effect.Effect<string, Error | PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
	runBytes(command, args).pipe(Effect.map((b) => new TextDecoder().decode(b).trim()))

/** Collects up to `max` bytes of a stream; reports whether more was produced. */
export const collectCapped = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, max: number) =>
	Stream.runFold(
		stream,
		() => ({ chunks: [] as Array<Uint8Array>, size: 0, truncated: false }),
		(acc, chunk) => {
			if (acc.size >= max) return { ...acc, truncated: true }
			const take = chunk.subarray(0, max - acc.size)
			acc.chunks.push(take)
			return { chunks: acc.chunks, size: acc.size + take.length, truncated: acc.truncated || take.length < chunk.length }
		}
	).pipe(Effect.map((acc) => ({ text: new TextDecoder().decode(concat(acc.chunks)), truncated: acc.truncated })))
