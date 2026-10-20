// `witness image`: build the computer image (Xvfb, Chromium, ffmpeg, control server)
// with the local Docker CLI. The npm package ships the build context with the
// control server already bundled; a checkout uses infra/computer after
// `pnpm build:control`.
import { fileURLToPath } from "node:url"
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** No build context, or `docker build` failed. */
export class ImageError extends Schema.TaggedError<ImageError>()("ImageError", { message: Schema.String }) {}

// dist/bin/witness.mjs -> dist/computer in the package; src/image.ts -> infra/computer in a checkout.
const CONTEXTS = ["../computer", "../../../infra/computer"].map((p) => fileURLToPath(new URL(p, import.meta.url)))

export const buildImage = Effect.fn("buildImage")(function* (tag: string | undefined) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const image = tag ?? (yield* Config.String("WITNESS_COMPUTER_IMAGE").pipe(Config.withDefault("witness-computer:dev")))

	const found = yield* Effect.findFirst(CONTEXTS, (dir) => fs.exists(path.join(dir, "control", "dist", "control.mjs")))
	if (Option.isNone(found)) {
		return yield* new ImageError({
			message: "no computer build context found; in a witness checkout run `pnpm build:control` first",
		})
	}
	const context = found.value

	yield* Console.log(`building ${image} from ${context}`)
	const code = yield* spawner
		.exitCode(
			ChildProcess.make("docker", ["build", "-t", image, context], {
				stderr: "inherit",
				stdin: "ignore",
				stdout: "inherit",
			})
		)
		.pipe(Effect.mapError((e) => new ImageError({ message: `could not run docker: ${e.message}` })))
	if (code !== 0) {
		return yield* new ImageError({ message: `docker build exited with ${code}` })
	}
	yield* Console.log(`built ${image}`)
})
