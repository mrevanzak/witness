// /artifacts: the only directory the control server reads or writes for callers.
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ArtifactNotFoundError, ArtifactPathError } from "../protocol.ts"

export const ARTIFACTS = "/artifacts"
const TAIL_BYTES = 2_000_000n

export class Artifacts extends Context.Service<
	Artifacts,
	{
		/** Absolute path under /artifacts, or a failure for anything outside it. */
		resolve: (path: string) => Effect.Effect<string, ArtifactPathError>
		/** Last `lines` lines of a file under /artifacts (reads at most the final 2 MB). */
		tail: (path: string, lines: number) => Effect.Effect<string, ArtifactPathError | ArtifactNotFoundError>
	}
>()("witness/computer/server/Artifacts") {
	static readonly layer = Layer.effect(
		Artifacts,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path

			const resolve = Effect.fn("Artifacts.resolve")(function* (p: string) {
				const abs = path.resolve(ARTIFACTS, p)
				if (abs !== ARTIFACTS && !abs.startsWith(`${ARTIFACTS}/`)) {
					return yield* new ArtifactPathError({ message: "path must be under /artifacts", path: p })
				}
				return abs
			})

			const tail = Effect.fn("Artifacts.tail")(function* (p: string, lines: number) {
				const file = yield* resolve(p)
				const notFound = () => new ArtifactNotFoundError({ message: `no such file: ${p}`, path: p })
				const { size } = yield* fs.stat(file).pipe(Effect.mapError(notFound))
				const offset = size > TAIL_BYTES ? size - TAIL_BYTES : 0n
				const bytes = yield* Stream.mkUint8Array(fs.stream(file, { offset })).pipe(Effect.mapError(notFound))
				return new TextDecoder().decode(bytes).split("\n").slice(-lines).join("\n")
			})

			return Artifacts.of({ resolve, tail })
		})
	)
}
