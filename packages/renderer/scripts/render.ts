// pnpm render:run runs/<id>
import { renderRun } from "../src/index.ts";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: render.ts <runDir>");
	process.exit(2);
}
const t = Date.now();
const r = await renderRun(dir, { onProgress: (l) => process.stderr.write(`\r${l.slice(0, 100).padEnd(100)}`) });
console.error("");
console.log(`polished.mp4 ${r.durationSec.toFixed(1)} s (${r.timeline.segments.length} segments) + preview.gif in ${((Date.now() - t) / 1000).toFixed(0)} s -> ${r.polished}`);
