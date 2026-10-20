import { assert, describe, it } from "@effect/vitest"
import { Criterion } from "@witness/domain"
import { Option } from "effect"
import { buildVerdict, type CriterionRecord, type ModeRun, pendingRecord, testerReview } from "../src/criteria.ts"

const C1 = new Criterion({ description: "empty title shows error", id: "C1", kind: "feature" })
const C2 = new Criterion({ description: "normal todo works", id: "C2", kind: "regression" })
const result = (criterion: Criterion, over: Partial<CriterionRecord>): CriterionRecord => ({
	...pendingRecord(criterion),
	status: "pass",
	...over,
})
const exec = (
	c1: Partial<CriterionRecord> = {}
): Pick<ModeRun, "records" | "console" | "network" | "stoppedBecause" | "summary"> => ({
	console: [
		{ at: 15_000, text: "boom", type: "error", url: "http://x" },
		{ at: 15_100, text: "noise", type: "log", url: "http://x" },
	],
	network: [],
	records: [
		result(C1, {
			beganAt: 11_000,
			endedAt: 19_960,
			notes: "no error",
			screenshot: "c1-fail.png",
			status: "fail",
			...c1,
		}),
		result(C2, { beganAt: 20_000, endedAt: 30_000, notes: "added", screenshot: "c2-pass.png", status: "pass" }),
	],
	stoppedBecause: "done",
	summary: "done",
})
const usage = { cacheRead: 10, cacheWrite: 0, input: 100, output: 50, requests: 3, usd: 0.123_45 }

describe("buildVerdict", () => {
	it("uses reviewer statuses, video times relative to t0, and only error-level console lines", () => {
		const v = buildVerdict({
			duration: Option.some(21),
			modelId: "m",
			review: {
				criteria: [
					{ explanation: "Error never appears.", id: "C1", status: "fail" },
					{ explanation: "Todo added.", id: "C2", status: "pass" },
				],
				notes: "",
			},
			run: exec(),
			t0: Option.some(10_000),
			usage,
		})
		assert.strictEqual(v.overall, "fail")
		assert.deepStrictEqual(v.criteria[0]!.video_ts, Option.some([1, 10] as const))
		assert.deepStrictEqual(v.criteria[0]!.screenshot, Option.some("c1-fail.png"))
		assert.strictEqual(v.criteria[0]!.explanation, "Error never appears.")
		assert.deepStrictEqual(
			v.console_errors.map((c) => [c.t, c.text]),
			[[5, "boom"]]
		)
		assert.strictEqual(v.usage.usd, 0.123)
	})

	it("never lets the reviewer override an orchestrator-forced block", () => {
		const v = buildVerdict({
			duration: Option.some(21),
			modelId: "m",
			review: {
				criteria: [
					{ explanation: "", id: "C1", status: "pass" },
					{ explanation: "", id: "C2", status: "pass" },
				],
				notes: "",
			},
			run: exec({ forced: "wall_time", status: "blocked" }),
			t0: Option.some(10_000),
			usage,
		})
		assert.strictEqual(v.criteria[0]!.status, "blocked")
		assert.strictEqual(v.overall, "blocked")
	})

	it("falls back to the tester's statuses, without timestamps when t0 is unknown", () => {
		const v = buildVerdict({
			duration: Option.none(),
			modelId: "m",
			review: testerReview(exec()),
			run: exec(),
			t0: Option.none(),
			usage,
		})
		assert.deepStrictEqual(
			v.criteria.map((c) => c.status),
			["fail", "pass"]
		)
		assert.isTrue(Option.isNone(v.criteria[0]!.video_ts))
	})
})
