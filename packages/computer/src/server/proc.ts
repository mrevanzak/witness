// Small helpers over effect/process for the control server.
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A helper command exited non-zero. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
	command: Schema.String,
	message: Schema.String,
}) {}

/** Runs a command and returns its stdout bytes; fails on a non-zero exit. */
export const runBytes = Effect.fnUntraced(function* (command: string, args: readonly string[]) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stderr: "ignore", stdin: "ignore" }))
	const bytes = yield* Stream.mkUint8Array(handle.stdout)
	const code = yield* handle.exitCode
	if (code !== ChildProcessSpawner.ExitCode(0)) {
		return yield* new CommandFailed({ command, message: `${command} exited ${code}` })
	}
	return bytes
}, Effect.scoped)

/** Runs a command and returns trimmed stdout; fails on a non-zero exit. */
export const runText = (command: string, args: readonly string[]) =>
	runBytes(command, args).pipe(Effect.map((b) => new TextDecoder().decode(b).trim()))

/** Collects up to `max` bytes of a stream (draining the rest); reports whether more was produced. */
export const collectCapped = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, max: number) =>
	Effect.suspend(() => {
		let size = 0
		let truncated = false
		const capped = Stream.map(stream, (chunk) => {
			const take = chunk.subarray(0, Math.max(0, max - size))
			size += take.length
			truncated ||= take.length < chunk.length
			return take
		})
		return Stream.mkUint8Array(capped).pipe(Effect.map((b) => ({ text: new TextDecoder().decode(b), truncated })))
	})
