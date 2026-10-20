// `witness publish --pr <N> --report <report.md> [--repo dir] [--mode auto|description|comment] [--ego-space <id>] [--dry-run]`
// Port of the moumint prototype's post-evidence.sh:
//   1. upload every ./file the report references through the PR's comment box in Ego
//      (infra/publish/github-upload.mjs) -> GitHub user-attachments URLs
//   2. swap the ./paths for those URLs
//   3. PR by the current gh user -> section in the description between
//      <!-- witness:start/end --> (replaced on re-runs, inserted above bot
//      footers); someone else's PR -> a new comment.
// --dry-run stops after writing the final markdown (no upload, no GitHub writes).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const UPLOADER = resolve(import.meta.dirname, "../../../infra/publish/github-upload.mjs");
export const START = "<!-- witness:start -->";
export const END = "<!-- witness:end -->";
const MEDIA = /\.\/[A-Za-z0-9._\/-]+\.(?:jpe?g|png|gif|mp4|mov|webm)/g;

/** Inserts or replaces the marked section in a PR body. Pure. */
export function placeSection(body: string, section: string): string {
	const trimmed = body.replace(/\s+$/, "");
	const block = `${START}\n${section.trim()}\n${END}`;
	const existing = new RegExp(`${START}[\\s\\S]*?${END}`);
	if (existing.test(trimmed)) return `${trimmed.replace(existing, () => block)}\n`;
	const footer = trimmed.search(/^(?:<!-- [\w-]+:footer -->|<!-- CURSOR_AGENT_PR_BODY_END -->|<div><a href="https:\/\/cursor\.com\/agents\/|🤖 Generated with)/m);
	if (footer === -1) return `${trimmed}\n\n${block}\n`;
	return `${trimmed.slice(0, footer).replace(/\s+$/, "")}\n\n${block}\n\n${trimmed.slice(footer)}\n`;
}

/** ./relative media paths a report references, first-seen order. Pure. */
export function referencedMedia(markdown: string): string[] {
	return [...new Set(markdown.match(MEDIA) ?? [])];
}

const gh = (args: string[], cwd: string) => execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();

export async function publish(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			pr: { type: "string" },
			report: { type: "string" },
			repo: { type: "string", default: "." },
			mode: { type: "string", default: "auto" },
			"ego-space": { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.pr || !values.report) {
		console.error("usage: witness publish --pr <N> --report <report.md> [--repo dir] [--mode auto|description|comment] [--ego-space id] [--dry-run]");
		return 3;
	}
	const repo = resolve(values.repo);
	const report = resolve(values.report);
	const base = dirname(report);
	let md = readFileSync(report, "utf8");
	const files = referencedMedia(md).map((r) => ({ ref: r, abs: join(base, r) }));
	const missing = files.filter((f) => !existsSync(f.abs));
	if (missing.length) {
		console.error(`report references missing files: ${missing.map((f) => f.ref).join(", ")}`);
		return 3;
	}

	let mode = values.mode;
	if (mode === "auto") {
		const author = gh(["pr", "view", values.pr, "--json", "author", "-q", ".author.login"], repo);
		const me = gh(["api", "user", "-q", ".login"], repo);
		mode = author === me ? "description" : "comment";
		console.error(`PR #${values.pr} author=${author}, me=${me} -> ${mode}`);
	}
	if (values["dry-run"]) {
		console.log(`dry run: would upload ${files.length} file(s) and update the ${mode}:\n${files.map((f) => `  ${f.ref}`).join("\n")}`);
		return 0;
	}

	// Upload once per report; a cached result is reused on re-runs.
	const cache = join(base, "upload-result.json");
	let urls: Record<string, string> = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : {};
	const todo = files.filter((f) => !urls[f.abs]);
	if (todo.length) {
		if (!values["ego-space"]) {
			console.error("--ego-space <id> is required to upload (an Ego task space signed in to GitHub)");
			return 3;
		}
		const prUrl = gh(["pr", "view", values.pr, "--json", "url", "-q", ".url"], repo);
		const script = `const { uploadToGitHub } = await import(${JSON.stringify(UPLOADER)});
const task = await taskSpace(${JSON.stringify(values["ego-space"])});
const urls = await uploadToGitHub(task, { prUrl: ${JSON.stringify(prUrl)}, files: ${JSON.stringify(todo.map((f) => f.abs))} });
console.log("UPLOADED " + JSON.stringify(urls));`;
		const r = spawnSync("ego-browser", ["nodejs"], { input: script, encoding: "utf8" });
		const line = `${r.stdout}\n${r.stderr}`.split("\n").find((l) => l.startsWith("UPLOADED "));
		if (!line) {
			console.error(`upload failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
			return 1;
		}
		urls = { ...urls, ...JSON.parse(line.slice("UPLOADED ".length)) };
		writeFileSync(cache, JSON.stringify(urls, null, 2));
	}
	for (const f of files) md = md.split(f.ref).join(urls[f.abs]!);
	const section = join(base, "pr-section.md");
	writeFileSync(section, md);

	if (mode === "comment") {
		gh(["pr", "comment", values.pr, "--body-file", section], repo);
		console.log(`commented on PR #${values.pr}`);
		return 0;
	}
	const before = gh(["pr", "view", values.pr, "--json", "body", "-q", ".body"], repo);
	writeFileSync(join(base, "pr-body.before.md"), before);
	writeFileSync(join(base, "pr-body.after.md"), placeSection(before, md));
	gh(["pr", "edit", values.pr, "--body-file", join(base, "pr-body.after.md")], repo);
	console.log(`updated the description of PR #${values.pr} (previous body in pr-body.before.md)`);
	return 0;
}
