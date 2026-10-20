// Phase 4 acceptance for a failing run: polished.mp4 < 60 s, a zoom on every click
// (played at 1x), and a freeze on the failing criterion. Writes render/sheet.png.
//   pnpm acceptance:phase4 runs/<id>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { outputTimeOf, renderRun, sourceTimeAt, zoomAt } from "../src/index.ts";

const dir = resolve(process.argv[2] ?? "");
const r = await renderRun(dir);
const tl = r.timeline;
const problems: string[] = [];
if (r.durationSec >= 60) problems.push(`polished.mp4 is ${r.durationSec.toFixed(1)} s (>= 60)`);

const steps = readFileSync(join(dir, "steps.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const clicks = steps.filter((s) => ["click", "double_click", "right_click", "click_element"].includes(s.tool));
for (const c of clicks) {
	const out = outputTimeOf(tl, c.t);
	if (out == null) {
		problems.push(`click at ${c.t}s is not in the video`);
		continue;
	}
	const { segment } = sourceTimeAt(tl, Math.floor(out * tl.fps));
	const z = zoomAt(tl.zoom, c.t);
	if (segment.kind !== "video" || segment.rate !== 1) problems.push(`click at ${c.t}s plays at ${segment.kind === "video" ? segment.rate : segment.kind}`);
	if (z.scale < 1.7) problems.push(`click at ${c.t}s not zoomed (scale ${z.scale.toFixed(2)})`);
	const dx = Math.abs(z.cx - c.x), dy = Math.abs(z.cy - c.y);
	const halfW = tl.screen.w / (2 * z.scale), halfH = tl.screen.h / (2 * z.scale);
	if (dx > halfW || dy > halfH) problems.push(`click at ${c.t}s is outside the zoomed view`);
}
const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
for (const c of verdict.criteria.filter((x: { status: string }) => x.status === "fail")) {
	if (!tl.segments.some((s) => s.kind === "freeze" && s.criterion === c.id)) problems.push(`no freeze for failing ${c.id}`);
}

// Contact sheet: each click, the first freeze, the end card.
const times = [...clicks.map((c) => outputTimeOf(tl, c.t)!), ...tl.segments.filter((s) => s.kind !== "video").map((s) => (s.from + s.frames / 2) / tl.fps)].filter((x) => x != null).slice(0, 12);
const tiles = times.map((t, i) => {
	const p = join(dir, "render", `tile${i}.png`);
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", r.polished, "-frames:v", "1", "-vf", "scale=640:-1", p]);
	return p;
});
const cols = 3;
const rows = Math.ceil(tiles.length / cols);
while (tiles.length < rows * cols) tiles.push(tiles.at(-1)!);
const inputs = tiles.flatMap((t) => ["-i", t]);
const rowF = Array.from({ length: rows }, (_, r) => `${Array.from({ length: cols }, (_, c) => `[${r * cols + c}]`).join("")}hstack=inputs=${cols}[r${r}]`).join(";");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", `${rowF};${Array.from({ length: rows }, (_, r) => `[r${r}]`).join("")}vstack=inputs=${rows}`, join(dir, "render", "sheet.png")]);

console.log(`polished ${r.durationSec.toFixed(1)} s from ${tl.sourceDuration.toFixed(1)} s raw; ${clicks.length} clicks; ${tl.segments.filter((s) => s.kind === "freeze").length} freeze(s)`);
console.log(problems.length ? `PHASE 4 NOT OK:\n- ${problems.join("\n- ")}` : "PHASE 4 OK");
process.exit(problems.length ? 1 : 0);
