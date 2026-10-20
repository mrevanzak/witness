// Renders runs/<id>/polished.mp4 (Remotion) and preview.gif (ffmpeg) from a run
// directory: computer/raw.mp4, steps.jsonl, plan.json, verdict.json, run.json.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildTimeline, outputTimeOf, type CriterionIn, type StepIn, type Timeline, type TimelineOptions } from "./timeline.ts";

const run = promisify(execFile);
const HERE = dirname(new URL(import.meta.url).pathname);
const ENTRY = resolve(HERE, "../remotion/index.ts");

export interface RenderResult {
	polished: string;
	gif: string;
	timeline: Timeline;
	durationSec: number;
}

async function probeDuration(file: string): Promise<number> {
	const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
	return Number.parseFloat(stdout.trim());
}

export function timelineForRun(runDir: string, sourceDuration: number, options?: Partial<TimelineOptions>, label?: string): Timeline {
	const steps: StepIn[] = readFileSync(join(runDir, "steps.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const verdict = JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8"));
	const runInfo = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
	const criteria: CriterionIn[] = verdict.criteria.map((c: CriterionIn) => ({
		id: c.id,
		kind: c.kind,
		description: c.description,
		status: c.status,
		explanation: c.explanation,
		screenshot: c.screenshot,
	}));
	const title = String(runInfo.task ?? "Verification").split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 110);
	return buildTimeline({ steps, criteria, overall: verdict.overall, title, sourceDuration, options, meta: { sha: String(runInfo.sha ?? "").slice(0, 7), label } });
}

function remotionBin(): string {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve("@remotion/cli/package.json")), "remotion-cli.js");
}

export async function renderRun(runDirIn: string, opts: { onProgress?: (line: string) => void; concurrency?: number; label?: string } = {}): Promise<RenderResult> {
	const runDir = resolve(runDirIn);
	const raw = join(runDir, "computer", "raw.mp4");
	if (!existsSync(raw)) throw new Error(`no recording at ${raw}`);
	const timeline = timelineForRun(runDir, await probeDuration(raw), undefined, opts.label);
	const outDir = join(runDir, "render");
	mkdirSync(outDir, { recursive: true });
	const propsPath = join(outDir, "props.json");
	writeFileSync(propsPath, JSON.stringify({ video: "computer/raw.mp4", title: timeline.end.title, timeline }));
	writeFileSync(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 1));

	const polished = join(runDir, "polished.mp4");
	const args = [
		remotionBin(),
		"render",
		ENTRY,
		"Polished",
		polished,
		`--props=${propsPath}`,
		`--public-dir=${runDir}`,
		"--codec=h264",
		"--crf=20",
		`--concurrency=${opts.concurrency ?? 4}`,
		"--log=warn",
	];
	await new Promise<void>((res, rej) => {
		const p = spawn(process.execPath, args, { cwd: resolve(HERE, ".."), stdio: ["ignore", "pipe", "pipe"] });
		let tail = "";
		const onData = (d: Buffer) => {
			const s = d.toString();
			tail = (tail + s).slice(-4000);
			for (const line of s.split(/\r|\n/)) if (line.trim()) opts.onProgress?.(line.trim());
		};
		p.stdout.on("data", onData);
		p.stderr.on("data", onData);
		p.on("close", (code) => (code === 0 ? res() : rej(new Error(`remotion render exited ${code}:\n${tail}`))));
	});

	// 10 s preview: start shortly before the first failing moment, else at the start.
	const firstFreeze = timeline.segments.find((s) => s.kind === "freeze");
	const total = timeline.durationInFrames / timeline.fps;
	const focus = firstFreeze ? firstFreeze.from / timeline.fps : 0;
	const start = Math.max(0, Math.min(focus - 6, total - 10));
	const gif = join(runDir, "preview.gif");
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-ss", start.toFixed(2), "-t", "10", "-i", polished,
		"-vf", "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
		gif,
	]);
	return { polished, gif, timeline, durationSec: await probeDuration(polished) };
}

export { outputTimeOf };
