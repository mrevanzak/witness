// Read-only git access to the repo under test (and to find the repo the CLI
// runs in). Never touches the working tree: sources come from `git archive` of
// the exact commit.
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A git command failed. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
	args: Schema.Array(Schema.String),
	message: Schema.String,
}) {}

export type RepoRef = {
	readonly baseSha: Option.Option<string>
	/** Path of the app inside the repo ("" for the root, else "examples/todo-app/"). */
	readonly prefix: string
	/** Repository toplevel. */
	readonly root: string
	readonly sha: string
}

export class Git extends Context.Service<
	Git,
	{
		/** Resolves `ref` (and the diff base) for an app directory that may be a subdirectory of its repo. */
		resolve: (dir: string, ref: string, base: Option.Option<string>) => Effect.Effect<RepoRef, GitError>
		/** `git archive` of the app directory at the exact commit. */
		archive: (repo: RepoRef) => Effect.Effect<Uint8Array, GitError>
		diff: (repo: RepoRef) => Effect.Effect<string, GitError>
		changedFiles: (
			repo: RepoRef
		) => Effect.Effect<ReadonlyArray<{ readonly status: string; readonly path: string }>, GitError>
		showFile: (repo: RepoRef, path: string) => Effect.Effect<Option.Option<string>, GitError>
		/** The toplevel of the repo that contains `dir`. */
		toplevel: (dir: string) => Effect.Effect<string, GitError>
	}
>()("witness/orchestrator/Git") {
	static readonly layer = Layer.effect(
		Git,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

			const bytes = (cwd: string, args: readonly string[]) =>
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
					const [out, err] = yield* Effect.all([Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr)], {
						concurrency: 2,
					})
					const code = yield* handle.exitCode
					if (code !== ChildProcessSpawner.ExitCode(0)) {
						return yield* new GitError({
							args,
							message: new TextDecoder().decode(concat(err)).trim() || `git exited ${code}`,
						})
					}
					return concat(out)
				}).pipe(
					Effect.scoped,
					Effect.catchTag("PlatformError", (e) => Effect.fail(new GitError({ args, message: e.message })))
				)
			const text = (cwd: string, args: readonly string[]) =>
				bytes(cwd, args).pipe(Effect.map((b) => new TextDecoder().decode(b)))
			const line = (cwd: string, args: readonly string[]) => text(cwd, args).pipe(Effect.map((s) => s.trim()))

			const toplevel = (dir: string) => line(dir, ["rev-parse", "--show-toplevel"])

			const resolve = Effect.fn("Git.resolve")(function* (dir: string, ref: string, base: Option.Option<string>) {
				const root = yield* toplevel(dir)
				const prefix = yield* line(dir, ["rev-parse", "--show-prefix"])
				const sha = yield* line(dir, ["rev-parse", "--verify", `${ref}^{commit}`])
				const candidates = Option.match(base, {
					onNone: () => ["origin/HEAD", "origin/main", "origin/master", "main", "master"],
					onSome: (b) => [b],
				})
				for (const c of candidates) {
					const b = yield* line(dir, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]).pipe(Effect.option)
					if (Option.isNone(b) || !b.value) {
						if (Option.isSome(base)) {
							return yield* new GitError({ args: ["rev-parse", c], message: `cannot resolve base ${c}` })
						}
						continue
					}
					const mergeBase = yield* line(dir, ["merge-base", b.value, sha])
					if (mergeBase === sha && Option.isNone(base)) {
						// The ref is on the default branch itself: diff against its parent.
						const parent = yield* line(dir, ["rev-parse", "--verify", "--quiet", `${sha}^`]).pipe(Effect.option)
						return { baseSha: Option.filter(parent, (p) => p.length > 0), prefix, root, sha }
					}
					return { baseSha: Option.some(mergeBase), prefix, root, sha }
				}
				return { baseSha: Option.none(), prefix, root, sha }
			})

			const scope = (r: RepoRef) => r.prefix || "."
			const range = (r: RepoRef, base: string) => `${base}...${r.sha}`

			return Git.of({
				archive: (r) =>
					bytes(r.root, ["archive", "--format=tar", r.prefix ? `${r.sha}:${r.prefix.replace(/\/$/, "")}` : r.sha]),
				changedFiles: (r) =>
					Option.match(r.baseSha, {
						onNone: () => Effect.succeed([]),
						onSome: (b) =>
							text(r.root, ["diff", "--name-status", "--find-renames", range(r, b), "--", scope(r)]).pipe(
								Effect.map((out) =>
									out
										.split("\n")
										.filter(Boolean)
										.map((l) => {
											const [status = "", ...paths] = l.split("\t")
											return { path: paths.at(-1) ?? "", status }
										})
								)
							),
					}),
				diff: (r) =>
					Option.match(r.baseSha, {
						onNone: () => Effect.succeed(""),
						onSome: (b) => text(r.root, ["diff", "--no-color", "--find-renames", range(r, b), "--", scope(r)]),
					}),
				resolve,
				showFile: (r, file) =>
					text(r.root, ["show", `${r.sha}:${r.prefix}${file}`]).pipe(
						Effect.option,
						Effect.map((o) => o)
					),
				toplevel,
			})
		})
	)
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
	let off = 0
	for (const c of chunks) {
		out.set(c, off)
		off += c.length
	}
	return out
}
