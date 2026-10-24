// Where runs live by default: `.witness/runs` at the git root of the current
// directory, so evidence stays next to the project wherever the CLI is
// installed, and `run` and `act` find the same sessions from any subfolder.
// `.witness/` carries its own `.gitignore` for `runs/`, so runs never show up in `git status`
// while `witness.yaml` and its scripts can be committed beside them.
import { Git } from "@witness/orchestrator"
import { Effect, FileSystem, Option, Path } from "effect"
import { Flag } from "effect/cli"

export const runsDirFlag = Flag.String("runs-dir").pipe(
	Flag.withDescription("Where run folders are (default: .witness/runs at the current git root)"),
	Flag.optional
)

/** `.witness/` at the git root of `dir` (or `dir` itself outside a repo), created and ignoring its runs. */
export const witnessHome = Effect.fnUntraced(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	// Not a repo, or no git at all: keep runs next to `dir`.
	const root = yield* Git.use((g) => g.toplevel(dir)).pipe(Effect.option)
	const home = path.join(
		Option.getOrElse(root, () => dir),
		".witness"
	)
	yield* fs.makeDirectory(home, { recursive: true })
	// A repo may commit its own version; only write ours when there is none.
	const ignore = path.join(home, ".gitignore")
	if (!(yield* fs.exists(ignore))) {
		yield* fs.writeFileString(ignore, "# Witness runs (recordings, screenshots, verdicts)\nruns/\n.gitignore\n")
	}
	return home
})

/** --runs-dir when given, else `runs` in the current directory's `witnessHome`. */
export const runsDirFor = Effect.fnUntraced(function* (flag: Option.Option<string>) {
	const path = yield* Path.Path
	if (Option.isSome(flag)) {
		return path.resolve(flag.value)
	}
	return path.join(yield* witnessHome(path.resolve(".")), "runs")
})
