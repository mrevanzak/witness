// Where runs live by default: `.witness/runs` at the git root of the current
// directory, so evidence stays next to the project wherever the CLI is
// installed, and `run` and `act` find the same sessions from any subfolder.
import { Git } from "@witness/orchestrator"
import { Effect, FileSystem, Option, Path } from "effect"

const WITNESS_DIR = ".witness"

/** The toplevel of the git repo containing `dir`, if it is in one. */
const gitRoot = (dir: string) => Git.use((g) => g.toplevel(dir)).pipe(Effect.option)

/** --runs-dir when given, else `.witness/runs` at the current git root (or the current directory outside a repo). */
export const runsDirFor = Effect.fnUntraced(function* (flag: Option.Option<string>) {
	const path = yield* Path.Path
	if (Option.isSome(flag)) {
		return path.resolve(flag.value)
	}
	const cwd = path.resolve(".")
	return path.join(
		Option.getOrElse(yield* gitRoot(cwd), () => cwd),
		WITNESS_DIR,
		"runs"
	)
})

/** `.gitignore` text with `.witness/` added, or none when it is already ignored. */
export const withWitnessIgnored = (text: string): Option.Option<string> => {
	const ignored = text
		.split("\n")
		.map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
		.includes(WITNESS_DIR)
	if (ignored) {
		return Option.none()
	}
	const sep = text === "" || text.endsWith("\n") ? "" : "\n"
	return Option.some(`${text}${sep}# Witness runs (recordings, screenshots, verdicts)\n${WITNESS_DIR}/\n`)
}

/** Adds `.witness/` to the `.gitignore` at the git root of `dir`. Returns the file when it changed it. */
export const ignoreWitnessDir = Effect.fnUntraced(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* gitRoot(path.resolve(dir))
	if (Option.isNone(root)) {
		return Option.none<string>()
	}
	const file = path.join(root.value, ".gitignore")
	const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
	const next = withWitnessIgnored(text)
	if (Option.isNone(next)) {
		return Option.none<string>()
	}
	yield* fs.writeFileString(file, next.value)
	return Option.some(file)
})
