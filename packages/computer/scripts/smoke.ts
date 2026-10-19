// Phase 1 acceptance: `pnpm verify:smoke`
//   create a computer -> open Chromium on a local test page -> click a button ->
//   save a screenshot -> stop in < 3 s -> raw.mp4 duration matches wall time (±1 s).
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DockerComputerProvider } from "../src/index.ts";

const runId = `smoke-${Date.now().toString(36)}`;
const dir = resolve("runs", runId);
const provider = new DockerComputerProvider();
const fail = (msg: string): never => {
	throw new Error(`SMOKE FAILED: ${msg}`);
};
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

const page = `<!doctype html><title>acv smoke</title>
<style>body{font:24px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f6}
button{font:inherit;padding:16px 32px;border-radius:12px;border:0;background:#4f46e5;color:#fff}</style>
<main><h1 id="status">Not clicked</h1><button id="go" onclick="document.getElementById('status').textContent='Clicked!'">Click me</button></main>`;

let t = performance.now();
const computer = await provider.create({ runId, artifactsDir: dir });
console.log(`created ${computer.id.slice(0, 12)} on ${computer.network} in ${ms(t)}`);

try {
	writeFileSync(join(dir, "smoke.html"), page);
	const rec = await computer.startRecording("raw.mkv");
	const recHostStart = Date.now();

	const nav = await computer.navigate("file:///artifacts/smoke.html");
	if (nav.error) fail(`navigate: ${nav.error}`);
	const before = await computer.pageSnapshot();
	const button = before.elements.find((e) => e.name === "Click me") ?? fail("button not in snapshot");
	console.log(`button at screen (${button.x}, ${button.y}); viewport origin (${before.viewport.x}, ${before.viewport.y})`);

	await computer.act({ type: "wait", ms: 800 });
	const shot = await computer.act({ type: "click", x: button.x, y: button.y });
	writeFileSync(join(dir, "after-click.png"), shot.png);
	const after = await computer.pageSnapshot();
	if (!after.text.includes("Clicked!")) fail(`click did not land; page text: ${after.text.slice(0, 200)}`);
	console.log(`clicked: cursor (${shot.cursor.x}, ${shot.cursor.y}), page says "Clicked!"`);
	await computer.act({ type: "wait", ms: 1500 });

	const recHostStop = Date.now();
	const result = await computer.stopRecording();
	const wall = (recHostStop - recHostStart) / 1000;
	console.log(`recording: ${result.duration.toFixed(2)} s for ${wall.toFixed(2)} s wall; t0 ${result.t0} (start requested ${rec.startedAt}, +${result.t0 ? result.t0 - rec.startedAt : "?"} ms)`);
	if (!existsSync(join(dir, "raw.mp4"))) fail("raw.mp4 missing");
	if (Math.abs(result.duration - wall) > 1) fail(`duration ${result.duration} vs wall ${wall}`);
	const probed = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, "raw.mp4")]).toString());
	if (!(probed > 0)) fail("raw.mp4 is not playable");
} finally {
	t = performance.now();
	await computer.destroy();
	const took = performance.now() - t;
	console.log(`destroyed in ${took.toFixed(0)} ms`);
	const left = await provider.docker.listContainers({ all: true, filters: { label: [`acv.run=${runId}`] } });
	const nets = await provider.docker.listNetworks({ filters: { label: [`acv.run=${runId}`] } });
	if (left.length || nets.length) fail(`left behind ${left.length} containers, ${nets.length} networks`);
	if (took > 3000) fail(`stop took ${took.toFixed(0)} ms (> 3 s)`);
}
console.log(`SMOKE OK -> ${dir}`);
