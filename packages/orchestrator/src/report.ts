// report.md in the "## Manual verification" format the moumint PRs use: a Preview
// line, one caption sentence above each still, the walkthrough video, notes.
// Media are referenced as ./relative paths inside the run dir; a publisher swaps
// them for hosted URLs (or the reader opens them locally).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Verdict } from "./verdict.ts";
import type { WalkthroughReport } from "./walkthrough.ts";

const ICON: Record<string, string> = { pass: "✅", fail: "❌", blocked: "⚠️" };

export interface ReportSection {
	/** Heading suffix, e.g. "(after)". */
	label?: string;
	runDir: string;
	/** Path prefix for media relative to the report file ("" when the report sits in runDir). */
	mediaPrefix?: string;
}

function load(runDir: string) {
	const verdict = JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")) as Verdict;
	const walk = existsSync(join(runDir, "walkthrough.json")) ? (JSON.parse(readFileSync(join(runDir, "walkthrough.json"), "utf8")) as WalkthroughReport) : null;
	const run = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
	return { verdict, walk, run };
}

export function criteriaTable(v: Verdict): string {
	const rows = v.criteria.map((c) => `| ${ICON[c.status] ?? ""} ${c.status} | ${c.id} ${c.kind === "regression" ? "(regression)" : ""} ${c.description} | ${c.video_ts ? `${c.video_ts[0]}s–${c.video_ts[1]}s of raw` : "–"} | ${c.explanation.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
	return [`| Result | Criterion | Video | What was seen |`, `|---|---|---|---|`, ...rows].join("\n");
}

/** One run's section (stills, walkthrough video, notes). */
export function sectionMarkdown(s: ReportSection): string {
	const { verdict, walk, run } = load(s.runDir);
	const p = s.mediaPrefix ?? "";
	const out: string[] = [];
	if (walk?.preview) out.push(`Preview: ${walk.preview}`);
	else out.push(`Preview: production build of \`${String(run.sha ?? "").slice(0, 7)}\` in a fresh ai-change-verifier computer (run \`${run.id ?? ""}\`).`);
	if (walk?.intro) out.push(walk.intro);
	const stills = walk?.stills.length
		? walk.stills.map((x) => ({ file: x.file, caption: x.caption }))
		: verdict.criteria.filter((c) => c.screenshot).map((c) => ({ file: c.screenshot!, caption: `${c.id} ${c.status}: ${c.explanation}` }));
	for (const st of stills) out.push(`${st.caption}\n\n![${st.caption.replace(/[[\]]/g, "")}](./${p}${st.file})`);
	if (!walk) out.push(criteriaTable(verdict));
	out.push(`Walkthrough${s.label ? ` ${s.label}` : ""}:\n\n./${p}polished.mp4`);
	return out.join("\n\n");
}

export function writeReport(runDir: string, opts: { notes?: string[] } = {}): string {
	const { verdict, walk } = load(runDir);
	const notes = [...(walk?.notes ?? []), ...(opts.notes ?? [])];
	if (!walk && verdict.notes) notes.push(verdict.notes);
	const md = [`## Manual verification`, sectionMarkdown({ runDir }), notes.length ? notes.map((n) => `- ${n}`).join("\n") : ""].filter(Boolean).join("\n\n");
	const path = join(runDir, "report.md");
	writeFileSync(path, `${md}\n`);
	return path;
}

/**
 * Before/after report from two runs of the same walkthrough: stills paired by name,
 * a criteria table with both statuses, both walkthrough videos. Copies every file it
 * references into `outDir`, so the folder is self-contained.
 */
export function writeComparisonReport(opts: { before: string; after: string; outDir: string; preview?: string; intro?: string }): string {
	const b = load(opts.before);
	const a = load(opts.after);
	mkdirSync(join(opts.outDir, "media"), { recursive: true });
	const copy = (runDir: string, file: string, prefix: string) => {
		const name = `${prefix}-${basename(file)}`;
		if (existsSync(join(runDir, file))) copyFileSync(join(runDir, file), join(opts.outDir, "media", name));
		return `./media/${name}`;
	};
	const out: string[] = ["## Manual verification"];
	out.push(`Preview: ${opts.preview ?? `before = ${b.walk?.preview ?? b.run.sha}; after = ${a.walk?.preview ?? a.run.sha}`}`);
	const intro = opts.intro ?? a.walk?.intro;
	if (intro) out.push(intro);

	const stillKey = (f: string) => basename(f).replace(/^\d+-/, "");
	const bStills = new Map((b.walk?.stills ?? []).map((s) => [stillKey(s.file), s]));
	for (const s of a.walk?.stills ?? []) {
		const before = bStills.get(stillKey(s.file));
		if (before) out.push(`${before.caption}\n\n![${before.caption.replace(/[[\]]/g, "")}](${copy(opts.before, before.file, "before")})`);
		out.push(`${s.caption}\n\n![${s.caption.replace(/[[\]]/g, "")}](${copy(opts.after, s.file, "after")})`);
	}

	const bStatus = new Map(b.verdict.criteria.map((c) => [c.id, c]));
	out.push(
		[
			"| Criterion | Before | After |",
			"|---|---|---|",
			...a.verdict.criteria.map((c) => {
				const bc = bStatus.get(c.id);
				const cell = (x?: { status: string; explanation: string }) => (x ? `${ICON[x.status] ?? ""} ${x.status}: ${x.explanation.replace(/\|/g, "\\|")}` : "–");
				return `| ${c.id}${c.kind === "regression" ? " (regression)" : ""} ${c.description} | ${cell(bc)} | ${cell(c)} |`;
			}),
		].join("\n")
	);
	for (const [label, dir] of [["after", opts.after], ["before", opts.before]] as const) {
		if (existsSync(join(dir, "polished.mp4"))) {
			copyFileSync(join(dir, "polished.mp4"), join(opts.outDir, "media", `${label}.mp4`));
			if (existsSync(join(dir, "preview.gif"))) copyFileSync(join(dir, "preview.gif"), join(opts.outDir, "media", `${label}.gif`));
			out.push(`Walkthrough (${label}):\n\n./media/${label}.mp4`);
		}
	}
	const notes = [...new Set([...(a.walk?.notes ?? []), ...(b.walk?.notes ?? [])])];
	if (notes.length) out.push(notes.map((n) => `- ${n}`).join("\n"));
	const path = join(opts.outDir, "report.md");
	writeFileSync(path, `${out.join("\n\n")}\n`);
	return path;
}
