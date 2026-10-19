import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/execute.ts";
import type { Model } from "../src/model.ts";
import { normalizePlan, type Plan } from "../src/plan.ts";
import { buildVerdict } from "../src/verdict.ts";
import { aggregateOverall } from "../src/verdict-rules.ts";

describe("aggregateOverall", () => {
	it.each([
		[["pass", "pass"], "pass"],
		[["pass", "fail"], "fail"],
		[["fail", "blocked"], "fail"],
		[["pass", "blocked"], "blocked"],
		[["blocked", "blocked"], "blocked"],
		[[], "blocked"],
	] as const)("%j -> %s", (statuses, overall) => {
		expect(aggregateOverall(statuses.map((status) => ({ status })))).toBe(overall);
	});
});

const plan: Plan = {
	summary: "s",
	criteria: [
		{ id: "C1", kind: "feature", description: "empty title shows error", how_to_check: "", evidence: "" },
		{ id: "C2", kind: "regression", description: "normal todo works", how_to_check: "", evidence: "" },
	],
};
const model = { id: "m", usage: { requests: 3, input: 100, output: 50, cacheRead: 10, cacheWrite: 0, usd: 0.12345 } } as unknown as Model;
const exec = (over: Partial<ExecuteResult["criteria"][number]>[] = []): Pick<ExecuteResult, "criteria" | "console" | "network" | "stoppedBecause" | "summary"> => ({
	criteria: [
		{ id: "C1", status: "fail", notes: "no error", beganAt: 11_000, endedAt: 19_960, screenshot: "c1-fail.png", console: [], network: [], steps: 4, ...over[0] },
		{ id: "C2", status: "pass", notes: "added", beganAt: 20_000, endedAt: 30_000, screenshot: "c2-pass.png", console: [], network: [], steps: 3, ...over[1] },
	],
	console: [
		{ at: 15_000, type: "error", text: "boom", url: "http://x" },
		{ at: 15_100, type: "log", text: "noise", url: "http://x" },
	],
	network: [],
	stoppedBecause: "done",
	summary: "done",
});

describe("buildVerdict", () => {
	it("uses reviewer statuses, video timestamps relative to t0, and only error-level console messages", () => {
		const v = buildVerdict({
			plan,
			exec: exec(),
			reviewed: { criteria: [{ id: "C1", status: "fail", explanation: "Error never appears." }, { id: "C2", status: "pass", explanation: "Todo added." }], notes: "" },
			t0: 10_000,
			duration: 21,
			model,
		});
		expect(v.overall).toBe("fail");
		expect(v.criteria[0]).toMatchObject({ id: "C1", status: "fail", video_ts: [1, 10], screenshot: "c1-fail.png", explanation: "Error never appears." });
		expect(v.console_errors).toEqual([{ t: 5, type: "error", text: "boom", url: "http://x" }]);
		expect(v.usage.usd).toBe(0.123);
	});

	it("never lets the reviewer override an orchestrator-forced block", () => {
		const v = buildVerdict({
			plan,
			exec: exec([{ status: "blocked", forced: "wall_time" }, {}]),
			reviewed: { criteria: [{ id: "C1", status: "pass", explanation: "" }, { id: "C2", status: "pass", explanation: "" }], notes: "" },
			t0: 10_000,
			duration: 21,
			model,
		});
		expect(v.criteria[0]!.status).toBe("blocked");
		expect(v.overall).toBe("blocked");
	});

	it("falls back to the tester's status when the reviewer skipped a criterion", () => {
		const v = buildVerdict({ plan, exec: exec(), reviewed: { criteria: [], notes: "" }, t0: null, duration: null, model });
		expect(v.criteria.map((c) => c.status)).toEqual(["fail", "pass"]);
		expect(v.criteria[0]!.video_ts).toBeNull();
	});
});

describe("normalizePlan", () => {
	const c = (kind: "feature" | "regression", id = "X") => ({ id, kind, description: "d", how_to_check: "h", evidence: "e" });
	it("renumbers ids and caps at 6", () => {
		const p = normalizePlan({ summary: " s ", criteria: [c("feature"), c("regression"), c("feature"), c("feature"), c("feature"), c("feature"), c("feature")] });
		expect(p.criteria.map((x) => x.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
		expect(p.summary).toBe("s");
	});
	it("requires a regression criterion and at least two criteria", () => {
		expect(() => normalizePlan({ summary: "", criteria: [c("feature"), c("feature")] })).toThrow(/regression/);
		expect(() => normalizePlan({ summary: "", criteria: [c("regression")] })).toThrow(/need 2 to 6/);
	});
});
