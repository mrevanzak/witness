import { assert, describe, it } from "@effect/vitest"
import { Plan } from "@witness/domain"
import { Option } from "effect"
import type { CriterionResult, ExecuteResult } from "../src/executor.ts"
import { buildVerdict, testerReview } from "../src/reviewer.ts"

const plan = new Plan({
	summary: "s",
	criteria: [
		{ id: "C1", kind: "feature", description: "empty title shows error", how_to_check: "", evidence: "" },
		{ id: "C2", kind: "regression", description: "normal todo works", how_to_check: "", evidence: "" },
	],
})
const result = (over: Partial<CriterionResult> & { id: string }): CriterionResult => ({
	status: "pass",
	notes: "",
	beganAt: undefined,
	endedAt: undefined,
	screenshot: undefined,
	evidence: undefined,
	console: [],
	network: [],
	forced: undefined,
	steps: 0,
	...over,
})
const exec = (c1: Partial<CriterionResult> = {}): Pick<ExecuteResult, "criteria" | "console" | "network" | "stoppedBecause" | "summary"> => ({
	criteria: [
		result({ id: "C1", status: "fail", notes: "no error", beganAt: 11_000, endedAt: 19_960, screenshot: "c1-fail.png", ...c1 }),
		result({ id: "C2", status: "pass", notes: "added", beganAt: 20_000, endedAt: 30_000, screenshot: "c2-pass.png" }),
	],
	console: [
		{ at: 15_000, type: "error", text: "boom", url: "http://x" },
		{ at: 15_100, type: "log", text: "noise", url: "http://x" },
	],
	network: [],
	stoppedBecause: "done",
	summary: "done",
})
const usage = { requests: 3, input: 100, output: 50, cacheRead: 10, cacheWrite: 0, usd: 0.12345 }

describe("buildVerdict", () => {
	it("uses reviewer statuses, video times relative to t0, and only error-level console lines", () => {
		const v = buildVerdict({
			plan,
			exec: exec(),
			review: { criteria: [{ id: "C1", status: "fail", explanation: "Error never appears." }, { id: "C2", status: "pass", explanation: "Todo added." }], notes: "" },
			t0: Option.some(10_000),
			duration: Option.some(21),
			modelId: "m",
			usage,
		})
		assert.strictEqual(v.overall, "fail")
		assert.deepStrictEqual(v.criteria[0]!.video_ts, Option.some([1, 10] as const))
		assert.deepStrictEqual(v.criteria[0]!.screenshot, Option.some("c1-fail.png"))
		assert.strictEqual(v.criteria[0]!.explanation, "Error never appears.")
		assert.deepStrictEqual(v.console_errors.map((c) => [c.t, c.text]), [[5, "boom"]])
		assert.strictEqual(v.usage.usd, 0.123)
	})

	it("never lets the reviewer override an orchestrator-forced block", () => {
		const v = buildVerdict({
			plan,
			exec: exec({ status: "blocked", forced: "wall_time" }),
			review: { criteria: [{ id: "C1", status: "pass", explanation: "" }, { id: "C2", status: "pass", explanation: "" }], notes: "" },
			t0: Option.some(10_000),
			duration: Option.some(21),
			modelId: "m",
			usage,
		})
		assert.strictEqual(v.criteria[0]!.status, "blocked")
		assert.strictEqual(v.overall, "blocked")
	})

	it("falls back to the tester's statuses, without timestamps when t0 is unknown", () => {
		const v = buildVerdict({ plan, exec: exec(), review: testerReview(exec()), t0: Option.none(), duration: Option.none(), modelId: "m", usage })
		assert.deepStrictEqual(v.criteria.map((c) => c.status), ["fail", "pass"])
		assert.isTrue(Option.isNone(v.criteria[0]!.video_ts))
	})
})
