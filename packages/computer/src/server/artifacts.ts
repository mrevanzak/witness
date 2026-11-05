// The artifacts directory: the only one the control server reads or writes for
// callers (/artifacts in the computer; a device run's folder on the host).
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ArtifactNotFoundError, ArtifactPathError } from "../protocol.ts"

export const ARTIFACTS = "/artifacts"
const TAIL_BYTES = 2_000_000n

type ArtifactsApi = {
	/** Absolute path under the root, or a failure for anything outside it. */
	resolve: (path: string) => Effect.Effect<string, ArtifactPathError>
	/** Last `lines` lines of a file under the root (reads at most the final 2 MB). */
	tail: (path: string, lines: number) => Effect.Effect<string, ArtifactPathError | ArtifactNotFoundError>
}

/** Artifacts rooted at `root`. */
export const makeArtifacts = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		const resolve = Effect.fn("Artifacts.resolve")(function* (p: string) {
			const abs = path.resolve(root, p)
			if (abs !== root && !abs.startsWith(`${root}/`)) {
				return yield* new ArtifactPathError({ message: `path must be under ${root}`, path: p })
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

		return { resolve, tail } satisfies ArtifactsApi
	})

export class Artifacts extends Context.Service<Artifacts, ArtifactsApi>()("witness/computer/server/Artifacts") {
	static readonly layer = Layer.effect(Artifacts, makeArtifacts(ARTIFACTS))
}
