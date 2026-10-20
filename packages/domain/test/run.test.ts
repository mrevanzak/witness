import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { aggregateOverall, redact, redactDeep, Step, Verdict } from "../src/index.ts"

// A verdict.json as the earlier (pre-Effect) runs wrote it.
const verdictJson = {
	console_errors: [{ t: 0, text: "404", type: "error", url: "http://x" }],
	criteria: [
		{
			description: "d",
			executor_status: "fail",
			explanation: "e",
			id: "C1",
			kind: "feature",
			screenshot: "c1-fail.png",
			status: "fail",
			video_ts: [0.7, 2.1],
		},
		{
			description: "d",
			executor_status: "blocked",
			explanation: "e",
			forced: "wall_time",
			id: "C2",
			kind: "regression",
			screenshot: null,
			status: "blocked",
			video_ts: null,
		},
	],
	duration_s: 5.27,
	model: "scripted",
	network_errors: [{ method: "GET", status: 404, t: null, url: "http://x/logo.svg" }],
	notes: "",
	overall: "fail",
	stopped_because: "done",
	summary: "",
	usage: { cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, requests: 3, usd: 0 },
}

describe("run artifacts", () => {
	it.effect("decodes and re-encodes verdict.json losslessly", () =>
		Effect.gen(function* () {
			const v = yield* Schema.decodeUnknownEffect(Verdict)(verdictJson)
			assert.deepStrictEqual(v.criteria[0]!.video_ts, Option.some([0.7, 2.1] as const))
			assert.isTrue(Option.isNone(v.criteria[1]!.screenshot))
			assert.deepStrictEqual<unknown>(yield* Schema.encodeEffect(Verdict)(v), verdictJson)
		})
	)

	it.effect("decodes step lines", () =>
		Effect.gen(function* () {
			const s = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(
				'{"at":1792439076447,"tool":"click_element","label":"Submit","criterion":"C1","x":1149,"y":281,"t":0.75}'
			)
			assert.strictEqual(s.tool, "click_element")
			assert.strictEqual(s.x, 1149)
		})
	)
})

describe("aggregateOverall", () => {
	it("fail beats blocked beats pass; nothing checked is blocked", () => {
		assert.strictEqual(aggregateOverall([{ status: "pass" }, { status: "pass" }]), "pass")
		assert.strictEqual(aggregateOverall([{ status: "pass" }, { status: "fail" }, { status: "blocked" }]), "fail")
		assert.strictEqual(aggregateOverall([{ status: "pass" }, { status: "blocked" }]), "blocked")
		assert.strictEqual(aggregateOverall([]), "blocked")
	})
})

describe("redact", () => {
	it("masks plain and URL-encoded secrets, deeply", () => {
		assert.strictEqual(redact("pw=s3cr et&x=s3cr%20et", ["s3cr et"]), "pw=[redacted]&x=[redacted]")
		assert.deepStrictEqual(redactDeep({ a: ["type hunter2"], n: 1 }, ["hunter2"]), { a: ["type [redacted]"], n: 1 })
	})
})
