// `witness publish`: put a report on a PR.
//   1. upload every ./file the report references through the PR's comment box in
//      Ego (a browser signed in to GitHub) -> GitHub user-attachments URLs
//   2. swap the ./paths for those URLs
//   3. the current gh user's PR -> section in the description between
//      <!-- witness:start/end --> (replaced on re-runs, above bot footers);
//      someone else's PR -> a new comment.
// --dry-run stops before any upload or GitHub write.
import { Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const START = "<!-- witness:start -->"
export const END = "<!-- witness:end -->"
const MEDIA = /\.\/[A-Za-z0-9._/-]+\.(?:jpe?g|png|gif|mp4|mov|webm)/g

/** Publishing failed (gh, Ego upload, or a missing file). */
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
 * The Ego script that attaches files to a PR's comment box and reads back the
 * user-attachments URLs GitHub inserts; the comment is never submitted, and the
 * box is cleared afterwards.
 */
export const uploadScript = (space: string, prUrl: string, files: readonly string[]) => `
const space = await taskSpace(${JSON.stringify(space)});
const page = await space.newPage();
const BOX = '#new_comment_field, textarea[name="comment[body]"]';
const urls = () => page.evaluate((sel) => [...(document.querySelector(sel)?.value ?? "").matchAll(/https:\\/\\/github\\.com\\/user-attachments\\/assets\\/[0-9a-fA-F-]+/g)].map((m) => m[0]), BOX);
const clear = () => page.evaluate((sel) => { const t = document.querySelector(sel); if (t) { t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); } }, BOX);
try {
	await page.goto(${JSON.stringify(prUrl)}, { timeout: 60000 });
	await page.waitForFunction((sel) => !!document.querySelector(sel), BOX, { timeout: 30000 });
	await clear();
	const out = {};
	for (const file of ${JSON.stringify(files)}) {
		const before = (await urls()).length;
		const chooser = page.waitForFileChooser({ timeout: 10000 });
		await page.click('loc=role:button[name*="Paste, drop, or click"]', { label: "attach a file to the comment box" });
		await (await chooser).setFiles(file);
		let found = [];
		for (let i = 0; i < 120 && found.length <= before; i++) { await page.waitForTimeout(500); found = await urls(); }
		if (found.length <= before) throw new Error("no attachment URL for " + file);
		out[file] = found[found.length - 1];
	}
	await clear();
	console.log("UPLOADED " + JSON.stringify(out));
} finally {
	await page.close().catch(() => {});
}
`

const Uploaded = Schema.Record(Schema.String, Schema.String)

export const publish = Effect.fn("publish")(function* (o: {
	readonly pr: string
	readonly report: string
	readonly repo: string
	readonly mode: "auto" | "description" | "comment"
	readonly egoSpace: Option.Option<string>
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
	let md = yield* fs.readFileString(report)
	const files = referencedMedia(md).map((ref) => ({ abs: path.join(base, ref), ref }))
	for (const f of files) {
		if (!(yield* fs.exists(f.abs))) {
			return yield* new PublishError({ message: `report references a missing file: ${f.ref}` })
		}
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
			`dry run: would upload ${files.length} file(s) and update the ${mode}:\n${files.map((f) => `  ${f.ref}`).join("\n")}`
		)
	}

	// Upload once per report; a cached result is reused on re-runs.
	const cache = path.join(base, "upload-result.json")
	let urls: Record<string, string> = (yield* fs.exists(cache))
		? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Uploaded))(yield* fs.readFileString(cache))
		: {}
	const todo = files.filter((f) => !urls[f.abs])
	if (todo.length) {
		if (Option.isNone(o.egoSpace)) {
			return yield* new PublishError({
				message: "--ego-space <id> is required to upload (an Ego task space signed in to GitHub)",
			})
		}
		const prUrl = yield* gh(["pr", "view", o.pr, "--json", "url", "-q", ".url"])
		const script = uploadScript(
			o.egoSpace.value,
			prUrl,
			todo.map((f) => f.abs)
		)
		const output = yield* spawner
			.string(
				ChildProcess.make("ego-browser", ["nodejs"], {
					stdin: { stream: Stream.make(new TextEncoder().encode(script)) },
				})
			)
			.pipe(Effect.mapError((e) => new PublishError({ message: `ego-browser: ${e.message}` })))
		const line = output.split("\n").find((l) => l.startsWith("UPLOADED "))
		if (!line) {
			return yield* new PublishError({ message: `upload produced no URLs:\n${output.slice(-1500)}` })
		}
		urls = {
			...urls,
			...(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Uploaded))(line.slice("UPLOADED ".length))),
		}
		yield* fs.writeFileString(cache, JSON.stringify(urls, null, 2))
	}
	for (const f of files) {
		md = md.split(f.ref).join(urls[f.abs] ?? f.ref)
	}
	const section = path.join(base, "pr-section.md")
	yield* fs.writeFileString(section, md)

	if (mode === "comment") {
		yield* gh(["pr", "comment", o.pr, "--body-file", section])
		return yield* Console.log(`commented on PR #${o.pr}`)
	}
	const before = yield* gh(["pr", "view", o.pr, "--json", "body", "-q", ".body"])
	yield* fs.writeFileString(path.join(base, "pr-body.before.md"), before)
	yield* fs.writeFileString(path.join(base, "pr-body.after.md"), placeSection(before, md))
	yield* gh(["pr", "edit", o.pr, "--body-file", path.join(base, "pr-body.after.md")])
	yield* Console.log(`updated the description of PR #${o.pr} (previous body in pr-body.before.md)`)
})
