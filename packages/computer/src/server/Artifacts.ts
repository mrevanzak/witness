// /artifacts: the only directory the control server reads or writes for callers.
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { ArtifactNotFoundError, ArtifactPathError } from "./Errors.ts"

export const ARTIFACTS = "/artifacts"

export class Artifacts extends Context.Service<
	Artifacts,
	{
		/** Absolute path under /artifacts, or a failure for anything outside it. */
		resolve(path: string): Effect.Effect<string, ArtifactPathError>
		/** Last `lines` lines of a file under /artifacts (reads at most the final 2 MB). */
		tail(path: string, lines: number): Effect.Effect<{ file: string; lines: string }, ArtifactPathError | ArtifactNotFoundError>
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
					return yield* new ArtifactPathError({ path: p, message: "path must be under /artifacts" })
				}
				return abs
			})

			const tail = Effect.fn("Artifacts.tail")(function* (p: string, lines: number) {
				const file = yield* resolve(p)
				const notFound = () => new ArtifactNotFoundError({ path: p, message: `no such file: ${p}` })
				const bytes = yield* fs.readFile(file).pipe(Effect.mapError(notFound))
				const text = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 2_000_000)))
				return { file, lines: text.split("\n").slice(-lines).join("\n") }
			})

			return Artifacts.of({ resolve, tail })
		})
	)
}
