// Deterministic end-to-end check of the whole pipeline without an API key: a
// scripted Model drives the real computer through the todo-app fixture branches.
//   pnpm e2e:scripted            -> expects feat/empty-title = pass, feat/empty-title-broken = fail
// It exercises boot, recording, the tool loop, steps.jsonl, evidence and verdict.json;
// it does not test the model's judgment (that is the Phase 3 live acceptance).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import { DockerComputerProvider } from "@witness/computer";
import { verifierAgent, verify, type Model, type ModelMessage, type ModelRequest, type Plan } from "../src/index.ts";

const PLAN: Plan = {
	summary: "Empty titles must be rejected with an inline error; adding a normal todo must keep working.",
	criteria: [
		{ id: "C1", kind: "feature", description: "Submitting an empty title shows 'Title is required' and adds nothing", how_to_check: "Click Add todo with the input empty", evidence: "Error text under the input; count stays at 2 items left" },
		{ id: "C2", kind: "regression", description: "Adding a normal todo still works", how_to_check: "Type 'Buy bread' and click Add todo", evidence: "'Buy bread' appears in the list" },
	],
};

type Block = ModelMessage["content"][number];
type Tool = { name: string; input: Record<string, unknown> };

/** Plays a fixed QA script; decisions read the latest page_snapshot text. */
class ScriptedModel implements Model {
	readonly id = "scripted";
	readonly usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
	private step = 0;
	private c1 = "blocked";

	private lastSnapshot(req: ModelRequest): string {
		for (const m of [...req.messages].reverse()) {
			if (m.role !== "user" || typeof m.content === "string") continue;
			for (const b of m.content) {
				if (b.type === "tool_result" && Array.isArray(b.content)) {
					const t = b.content.find((c) => c.type === "text" && c.text.startsWith("URL:"));
					if (t && t.type === "text") return t.text;
				}
			}
		}
		return "";
	}

	private ref(snap: string, pattern: RegExp): string {
		const line = snap.split("\n").find((l) => /^e\d+ /.test(l) && pattern.test(l));
		if (!line) throw new Error(`scripted model: no element matching ${pattern} in snapshot`);
		return line.split(" ")[0]!;
	}

	private msg(tools: Tool[], text?: string): ModelMessage {
		this.usage.requests++;
		const content: Block[] = [
			...(text ? [{ type: "text", text, citations: null } as Block] : []),
			...tools.map((t, i) => ({ type: "tool_use", id: `tu_${this.step}_${i}`, name: t.name, input: t.input, caller: { type: "direct" } }) as unknown as Block),
		];
		return { id: `msg_${this.step}`, type: "message", role: "assistant", model: this.id, content, stop_reason: tools.length ? "tool_use" : "end_turn", usage: { input_tokens: 0, output_tokens: 0 } } as unknown as ModelMessage;
	}

	async create(req: ModelRequest): Promise<ModelMessage> {
		// Simulated model latency (SCRIPTED_DELAY_MS) gives realistic idle stretches for the renderer.
		const delay = Number(process.env.SCRIPTED_DELAY_MS ?? 0);
		if (delay) await new Promise((r) => setTimeout(r, delay * (0.6 + ((this.step * 37) % 10) / 12.5)));
		const snap = this.lastSnapshot(req);
		const s = this.step++;
		switch (s) {
			case 0:
				return this.msg([{ name: "begin_criterion", input: { id: "C1" } }, { name: "page_snapshot", input: {} }]);
			case 1:
				return this.msg([{ name: "click_element", input: { ref: this.ref(snap, /"Add todo"/), label: "Submit with an empty title" } }]);
			case 2:
				return this.msg([{ name: "wait", input: { ms: 800, label: "Wait for the list to update" } }, { name: "page_snapshot", input: {} }]);
			case 3: {
				const error = snap.includes("Title is required");
				const count = snap.match(/(\d+) items? left/)?.[1];
				this.c1 = error && count === "2" ? "pass" : "fail";
				const notes = `Error text ${error ? "shown" : "not shown"}; counter says ${count} items left (was 2).`;
				return this.msg([{ name: "end_criterion", input: { id: "C1", status: this.c1, notes } }]);
			}
			case 4:
				return this.msg([{ name: "begin_criterion", input: { id: "C2" } }, { name: "page_snapshot", input: {} }]);
			case 5:
				return this.msg([
					{ name: "click_element", input: { ref: this.ref(snap, /textbox|input/), label: "Focus the title field" } },
					{ name: "type", input: { text: "Buy bread", label: "Type 'Buy bread'" } },
				]);
			case 6:
				return this.msg([{ name: "key", input: { combo: "Return", label: "Press Enter to add" } }]);
			case 7:
				return this.msg([{ name: "wait", input: { ms: 800, label: "Wait for the new todo" } }, { name: "page_snapshot", input: {} }]);
			case 8: {
				const ok = snap.includes("Buy bread");
				return this.msg([{ name: "end_criterion", input: { id: "C2", status: ok ? "pass" : "fail", notes: ok ? "'Buy bread' is in the list." : "'Buy bread' did not appear." } }]);
			}
			default:
				return this.msg([], "Checked both criteria.");
		}
	}

	async parse<T>(req: ModelRequest, schema: z.ZodType<T>): Promise<{ parsed: T | null; message: ModelMessage }> {
		this.usage.requests++;
		const message = { stop_reason: "end_turn", content: [], usage: { input_tokens: 0, output_tokens: 0 } } as unknown as ModelMessage;
		const isPlan = typeof req.system === "string" && req.system.includes("planning stage");
		if (isPlan) return { parsed: schema.parse(PLAN), message };
		// Reviewer: echo the tester's statuses, read from the prompt.
		const text = JSON.stringify(req.messages);
		const statuses = [...text.matchAll(/## (C\d)[^#]*?Tester status: (pass|fail|blocked)/g)].map((m) => ({ id: m[1]!, status: m[2]! as "pass" | "fail" | "blocked", explanation: `Scripted review of ${m[1]}.` }));
		return { parsed: schema.parse({ criteria: statuses, notes: "" }), message };
	}
}

const root = resolve(import.meta.dirname, "../../..");
const fixture = execFileSync("bash", [resolve(root, "examples/todo-app/make-fixture.sh")]).toString().trim();
const provider = new DockerComputerProvider();
const only = process.argv[2];
const cases = [
	{ ref: "feat/empty-title", expect: "pass" },
	{ ref: "feat/empty-title-broken", expect: "fail" },
].filter((c) => !only || c.ref === only) as Array<{ ref: string; expect: "pass" | "fail" }>;

let failed = 0;
for (const c of cases) {
	const outcome = await verify(provider, { repo: fixture, ref: c.ref, base: "main", task: "Validate empty todo titles", runsDir: resolve(root, "runs") }, verifierAgent({ model: new ScriptedModel() }));
	const v = outcome.verdictPath ? JSON.parse(readFileSync(outcome.verdictPath, "utf8")) : null;
	const ok = outcome.overall === c.expect;
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} ${c.ref}: ${outcome.overall} (expected ${c.expect})`, v?.criteria?.map((x: { id: string; status: string; video_ts: unknown }) => `${x.id}=${x.status} ${JSON.stringify(x.video_ts)}`).join(" "), outcome.runDir);
}
process.exit(failed ? 1 : 0);
