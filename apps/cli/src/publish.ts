// `witness publish`: put a report on a PR.
//   1. gh (2.99+) uploads every ./file the report references with --attach and
//      repoints each reference at its GitHub URL
//   2. the current gh user's PR -> section in the description between
//      <!-- witness:start/end --> (replaced on re-runs, above bot footers);
//      someone else's PR -> a new comment.
// --dry-run stops before any upload or GitHub write.
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const START = "<!-- witness:start -->"
export const END = "<!-- witness:end -->"
const MEDIA = /\.\/[A-Za-z0-9._/-]+\.(?:jpe?g|png|gif|mp4|mov|webm)/g
const VIDEO_LINE = /^(\.\/[A-Za-z0-9._/-]+\.(?:mp4|mov|webm))$/gm
const MAX_ATTACH = 50

/** Publishing failed (gh, or a missing file). */
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", { message: Schema.String }) {}

/** Inserts or replaces the marked section in a PR body. Pure. */
export const placeSection = (body: string, section: string): string => {
	const trimmed = body.replace(/\s+$/, "")
	const block = `${START}\n${section.trim()}\n${END}`
	const existing = new RegExp(`${START}[\\s\\S]*?${END}`)
	if (existing.test(trimmed)) {
		return `${trimmed.replace(existing, () => block)}\n`
	}
	const footer = trimmed.search(
		/^(?:<!-- [\w-]+:footer -->|<!-- CURSOR_AGENT_PR_BODY_END -->|<div><a href="https:\/\/cursor\.com\/agents\/|🤖 Generated with)/m
	)
	if (footer === -1) {
		return `${trimmed}\n\n${block}\n`
	}
	return `${trimmed.slice(0, footer).replace(/\s+$/, "")}\n\n${block}\n\n${trimmed.slice(footer)}\n`
}

/** ./relative media paths a report references, first-seen order. Pure. */
export const referencedMedia = (markdown: string): readonly string[] => [...new Set(markdown.match(MEDIA) ?? [])]

/**
 * Turns a video path standing alone on a line into an embed, the one form gh
 * rewrites to a bare URL that GitHub renders as a player. Pure.
 */
export const embedVideos = (markdown: string): string => markdown.replace(VIDEO_LINE, "![Walkthrough]($1)")

export const publish = Effect.fn("publish")(function* (o: {
	readonly pr: string
	readonly report: string
	readonly repo: string
	readonly mode: "auto" | "description" | "comment"
	readonly dryRun: boolean
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const repo = path.resolve(o.repo)
	const gh = (args: readonly string[]) =>
		spawner.string(ChildProcess.make("gh", args, { cwd: repo })).pipe(
			Effect.map((s) => s.trim()),
			Effect.mapError((e) => new PublishError({ message: `gh ${args[0]}: ${e.message}` }))
		)

	const report = path.resolve(o.report)
	const base = path.dirname(report)
	// Body files live beside the report: gh resolves their ./references from there.
	const md = embedVideos(yield* fs.readFileString(report))
	const files = referencedMedia(md).map((ref) => ({ abs: path.join(base, ref), ref }))
	for (const f of files) {
		if (!(yield* fs.exists(f.abs))) {
			return yield* new PublishError({ message: `report references a missing file: ${f.ref}` })
		}
	}
	if (files.length > MAX_ATTACH) {
		return yield* new PublishError({
			message: `gh attaches at most ${MAX_ATTACH} files; the report has ${files.length}`,
		})
	}

	let mode = o.mode
	if (mode === "auto") {
		const author = yield* gh(["pr", "view", o.pr, "--json", "author", "-q", ".author.login"])
		const me = yield* gh(["api", "user", "-q", ".login"])
		mode = author === me ? "description" : "comment"
		yield* Console.error(`PR #${o.pr} author=${author}, me=${me} -> ${mode}`)
	}
	if (o.dryRun) {
		return yield* Console.log(
			`dry run: would attach ${files.length} file(s) and update the ${mode}:\n${files.map((f) => `  ${f.ref}`).join("\n")}`
		)
	}

	const attach = files.flatMap((f) => ["--attach", f.abs])
	if (mode === "comment") {
		const section = path.join(base, "pr-section.md")
		yield* fs.writeFileString(section, md)
		yield* gh(["pr", "comment", o.pr, "--body-file", section, ...attach])
		return yield* Console.log(`commented on PR #${o.pr}`)
	}
	const before = yield* gh(["pr", "view", o.pr, "--json", "body", "-q", ".body"])
	yield* fs.writeFileString(path.join(base, "pr-body.before.md"), before)
	yield* fs.writeFileString(path.join(base, "pr-body.after.md"), placeSection(before, md))
	yield* gh(["pr", "edit", o.pr, "--body-file", path.join(base, "pr-body.after.md"), ...attach])
	yield* Console.log(`updated the description of PR #${o.pr} (previous body in pr-body.before.md)`)
})
