// Phase 3 live acceptance: the real model must return `pass` for the correct branch
// and `fail` for the broken one in at least 4 of 5 runs each, with sane timestamps.
//   ANTHROPIC_API_KEY=... pnpm acceptance:phase3 [runsPerBranch=5]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DockerComputerProvider } from "@acv/computer";
import { verifierAgent, verify, type Verdict } from "../src/index.ts";

const N = Number(process.argv[2] ?? 5);
const root = resolve(import.meta.dirname, "../../..");
const fixture = execFileSync("bash", [resolve(root, "examples/todo-app/make-fixture.sh")]).toString().trim();
const provider = new DockerComputerProvider();
const TASK = "Adding a todo with an empty or whitespace-only title should show 'Title is required' under the input and must not add the todo.";
const branches = [
	{ ref: "feat/empty-title", expect: "pass" },
	{ ref: "feat/empty-title-broken", expect: "fail" },
] as const;

let ok = true;
let usd = 0;
for (const b of branches) {
	let hits = 0;
	for (let i = 1; i <= N; i++) {
		const out = await verify(provider, { repo: fixture, ref: b.ref, base: "main", task: TASK, runsDir: resolve(root, "runs") }, verifierAgent());
		const v: Verdict | null = out.verdictPath ? JSON.parse(readFileSync(out.verdictPath, "utf8")) : null;
		usd += v?.usage.usd ?? 0;
		// Timestamps must lie inside the video and be ordered.
		const tsOk = !!v && v.criteria.every((c) => !c.video_ts || (c.video_ts[0] <= c.video_ts[1] && c.video_ts[1] <= (v.duration_s ?? 0) + 1));
		const failTs = b.expect !== "fail" || (v?.criteria.some((c) => c.status === "fail" && c.video_ts) ?? false);
		const hit = out.overall === b.expect && tsOk && failTs;
		if (hit) hits++;
		console.log(`${b.ref} #${i}: ${out.overall}${hit ? "" : "  <-- miss"}  ${v?.criteria.map((c) => `${c.id}=${c.status}`).join(" ") ?? ""}  $${v?.usage.usd.toFixed(2) ?? "?"}  ${out.runDir}`);
	}
	const pass = hits >= Math.ceil(N * 0.8);
	ok &&= pass;
	console.log(`=> ${b.ref}: ${hits}/${N} ${pass ? "OK" : "NOT OK"}\n`);
}
console.log(`total model spend ≈ $${usd.toFixed(2)}`);
process.exit(ok ? 0 : 1);
