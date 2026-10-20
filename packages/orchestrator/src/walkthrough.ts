// In-session mode: a walkthrough script (written by the Claude Code session that
// explored the app, or by a human) drives the computer instead of the API model.
// Same recording, step log, evidence, verdict and polished video as the agent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleMessage, NetworkEvent, PageElement } from "@acv/computer";
import type { CriterionResult, ExecuteResult } from "./execute.ts";
import type { Model } from "./model.ts";
import type { Plan } from "./plan.ts";
import { redact } from "./redact.ts";
import { StepLog } from "./steps.ts";
import { buildVerdict } from "./verdict.ts";
import type { CriterionKind, CriterionStatus } from "./verdict-rules.ts";
import type { AgentContext } from "./verify-run.ts";

export interface Still {
	file: string;
	caption: string;
	/** Seconds into raw.mp4, filled in after the recording stops. */
	t?: number;
	at: number;
}

export interface WalkthroughContext extends AgentContext {
	steps: StepLog;
	/** Declare a criterion (call before begin). */
	criterion(id: string, kind: CriterionKind, description: string): void;
	begin(id: string): Promise<void>;
	end(id: string, status: CriterionStatus, notes: string): Promise<void>;
	click(x: number, y: number, label: string): Promise<void>;
	/** Clicks the first visible interactive element whose name matches. Returns it. */
	clickText(match: string | RegExp, label: string, opts?: { tag?: string; timeoutMs?: number }): Promise<PageElement>;
	findElement(match: string | RegExp, opts?: { tag?: string; timeoutMs?: number }): Promise<PageElement>;
	type(text: string, label: string): Promise<void>;
	key(combo: string, label: string): Promise<void>;
	scroll(dy: number, label: string, at?: { x: number; y: number }): Promise<void>;
	navigate(url: string, label: string): Promise<void>;
	wait(ms: number, label?: string): Promise<void>;
	/** Evaluates a JS expression in the visible tab (via CDP inside the computer). */
	evaluate<T = unknown>(expression: string): Promise<T>;
	/** Polls `expression` until truthy. */
	waitFor(expression: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
	/** Full-res still for the report, with the sentence that says what it proves. */
	still(name: string, caption: string): Promise<string>;
	note(line: string): void;
	preview(line: string): void;
	intro(line: string): void;
}

export interface WalkthroughReport {
	preview: string;
	intro: string;
	stills: Still[];
	notes: string[];
}

export type Walkthrough = (ctx: WalkthroughContext) => Promise<void>;

// Actions only need the timestamp; keep the returned screenshot tiny.
const SMALL = { width: 320, format: "jpeg" as const, quality: 50 };

const EVAL_JS = `
const { chromium } = require("/opt/control/node_modules/playwright-core");
(async () => {
	const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
	const pages = b.contexts().flatMap((c) => c.pages()).filter((p) => !p.url().startsWith("devtools://"));
	let page = pages.at(-1);
	for (const p of [...pages].reverse()) {
		if ((await p.evaluate(() => document.visibilityState).catch(() => "hidden")) === "visible") { page = p; break; }
	}
	const value = await page.evaluate(process.env.ACV_EXPR);
	process.stdout.write(JSON.stringify(value === undefined ? null : value));
	process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;

export function walkthroughAgent(fn: Walkthrough, opts: { title?: string } = {}) {
	return async (base: AgentContext): Promise<string> => {
		const { run, computer } = base;
		const steps = new StepLog(join(run.dir, "steps.jsonl"), run.secrets);
		mkdirSync(join(run.dir, "stills"), { recursive: true });
		const plan: Plan = { summary: opts.title ?? base.change.task.split("\n")[0]!, criteria: [] };
		const results = new Map<string, CriterionResult>();
		const report: WalkthroughReport = { preview: "", intro: "", stills: [], notes: [] };
		const allConsole: ConsoleMessage[] = [];
		const allNetwork: NetworkEvent[] = [];
		let active: string | undefined;
		let stillNo = 0;
		const first = await computer.screenshot({ width: 640, format: "jpeg" });
		const offset = first.at - Date.now();
		const now = () => Date.now() + offset;

		const drain = async () => {
			const [c, n] = await Promise.all([computer.consoleMessages().catch(() => []), computer.networkEvents().catch(() => [])]);
			allConsole.push(...c);
			allNetwork.push(...n);
			const r = active ? results.get(active) : undefined;
			if (r) {
				r.console.push(...c);
				r.network.push(...n);
			}
		};

		const ctx: WalkthroughContext = {
			...base,
			steps,
			criterion(id, kind, description) {
				plan.criteria.push({ id, kind, description, how_to_check: "", evidence: "" });
			},
			async begin(id) {
				if (!plan.criteria.some((c) => c.id === id)) throw new Error(`criterion ${id} not declared`);
				await drain();
				active = id;
				const r: CriterionResult = { id, status: "blocked", notes: "", beganAt: now(), console: [], network: [], steps: 0 };
				results.set(id, r);
				steps.add({ at: r.beganAt!, tool: "begin_criterion", criterion: id, label: `${id}: ${plan.criteria.find((c) => c.id === id)!.description}` });
			},
			async end(id, status, notes) {
				const r = results.get(id);
				if (!r) throw new Error(`criterion ${id} was not begun`);
				await drain();
				const full = await computer.screenshot();
				const file = `${id.toLowerCase()}-${status}.png`;
				writeFileSync(join(run.dir, file), full.png);
				Object.assign(r, { status, notes: redact(notes, run.secrets), endedAt: full.at, screenshot: file });
				steps.add({ at: full.at, tool: "end_criterion", criterion: id, status, label: `${id}: ${status.toUpperCase()}`, notes: r.notes });
				active = undefined;
			},
			async click(x, y, label) {
				const s = await computer.act({ type: "click", x, y, settle_ms: 100, shot: SMALL });
				steps.add({ at: s.actionAt ?? s.at ?? now(), tool: "click", label, criterion: active, x, y });
			},
			async findElement(match, o = {}) {
				const deadline = Date.now() + (o.timeoutMs ?? 15_000);
				const test = (name: string) => (typeof match === "string" ? name.toLowerCase().includes(match.toLowerCase()) : match.test(name));
				for (;;) {
					const snap = await computer.pageSnapshot({ maxText: 100 });
					const el = snap.elements.find((e) => test(e.name) && (!o.tag || e.tag === o.tag) && !e.disabled);
					if (el) return el;
					if (Date.now() > deadline) throw new Error(`no element matching ${String(match)} on ${snap.url}; saw: ${snap.elements.map((e) => e.name).filter(Boolean).slice(0, 30).join(" | ")}`);
					await new Promise((r) => setTimeout(r, 300));
				}
			},
			async clickText(match, label, o) {
				const el = await ctx.findElement(match, o);
				await ctx.click(el.x, el.y, label);
				return el;
			},
			async type(text, label) {
				const s = await computer.act({ type: "type", text, settle_ms: 100, shot: SMALL });
				steps.add({ at: s.actionAt ?? s.at, tool: "type", label, criterion: active, chars: text.length });
			},
			async key(combo, label) {
				const s = await computer.act({ type: "key", combo, settle_ms: 100, shot: SMALL });
				steps.add({ at: s.actionAt ?? s.at, tool: "key", label, criterion: active, combo });
			},
			async scroll(dy, label, at) {
				const s = await computer.act({ type: "scroll", dy, ...(at ?? {}), settle_ms: 200, shot: SMALL });
				steps.add({ at: s.actionAt ?? s.at, tool: "scroll", label, criterion: active, ...(at ?? {}) });
			},
			async navigate(url, label) {
				const nav = await computer.navigate(url, { timeoutMs: 60_000 });
				if (nav.error) throw new Error(`navigate ${url}: ${nav.error}`);
				steps.add({ at: nav.at, tool: "navigate", label, criterion: active, url });
			},
			async wait(ms, label) {
				const s = await computer.act({ type: "wait", ms, shot: SMALL });
				if (label) steps.add({ at: s.actionAt ?? s.at, tool: "wait", label, criterion: active });
			},
			async evaluate<T>(expression: string) {
				const r = await computer.exec({ cmd: `node -e '${EVAL_JS.replace(/'/g, `'\\''`)}'`, env: { ACV_EXPR: expression }, timeoutMs: 30_000 });
				if (r.code !== 0) throw new Error(`evaluate failed: ${r.stderr.slice(0, 1000)}`);
				return JSON.parse(r.stdout || "null") as T;
			},
			async waitFor(expression, o = {}) {
				const deadline = Date.now() + (o.timeoutMs ?? 30_000);
				for (;;) {
					if (await ctx.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
					if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
					await new Promise((r) => setTimeout(r, o.intervalMs ?? 250));
				}
			},
			async still(name, caption) {
				const s = await computer.screenshot();
				const file = `stills/${String(++stillNo).padStart(2, "0")}-${name}.png`;
				writeFileSync(join(run.dir, file), s.png);
				report.stills.push({ file, caption: redact(caption, run.secrets), at: s.at });
				steps.add({ at: s.at, tool: "still", criterion: active, file });
				return file;
			},
			note: (line) => void report.notes.push(redact(line, run.secrets)),
			preview: (line) => void (report.preview = line),
			intro: (line) => void (report.intro = line),
		};

		await drain();
		await computer.startRecording("raw.mkv");
		await computer.act({ type: "wait", ms: 600 });
		let error: unknown;
		try {
			await fn(ctx);
		} catch (e) {
			error = e;
			run.log("walkthrough.error", { message: String((e as Error).message ?? e) });
		}
		await computer.act({ type: "wait", ms: 800 }).catch(() => undefined);
		await drain();
		const rec = await computer.stopRecording();
		const finalSteps = steps.finalize(rec.t0);
		for (const s of report.stills) s.t = rec.t0 ? Math.round((s.at - rec.t0) / 100) / 10 : undefined;

		// Anything declared but not finished is blocked (with the error, if any).
		for (const c of plan.criteria) {
			const r = results.get(c.id);
			if (!r?.endedAt) {
				const reason = error ? `walkthrough stopped: ${String((error as Error).message ?? error).slice(0, 300)}` : "not reached by the walkthrough";
				results.set(c.id, { id: c.id, status: "blocked", notes: reason, beganAt: r?.beganAt, endedAt: r?.endedAt, console: r?.console ?? [], network: r?.network ?? [], steps: 0, forced: "walkthrough" });
			}
		}
		const exec: Pick<ExecuteResult, "criteria" | "console" | "network" | "stoppedBecause" | "summary"> = {
			criteria: plan.criteria.map((c) => results.get(c.id)!),
			console: allConsole,
			network: allNetwork,
			stoppedBecause: error ? "model_gave_up" : "done",
			summary: "",
		};
		const model = { id: "in-session", usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 } } as unknown as Model;
		if (error) report.notes.push(`Walkthrough error: ${redact(String((error as Error).message ?? error), run.secrets).slice(0, 500)}`);
		const reviewed = { criteria: exec.criteria.map((r) => ({ id: r.id, status: r.status, explanation: r.notes })), notes: report.notes.join("\n") };
		run.writeJson("plan.json", plan);
		run.writeJson("walkthrough.json", report);
		const verdict = buildVerdict({ plan, exec, reviewed, t0: rec.t0, duration: rec.duration, model });
		const path = run.writeJson("verdict.json", verdict);
		run.log("verdict", { overall: verdict.overall, criteria: verdict.criteria.map((c) => `${c.id}=${c.status}`), steps: finalSteps.length });
		return path;
	};
}
