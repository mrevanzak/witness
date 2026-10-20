import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Step, Verdict, aggregateOverall, redact, redactDeep } from "../src/index.ts"

// A verdict.json as the earlier (pre-Effect) runs wrote it.
const verdictJson = {
	overall: "fail",
	summary: "",
	criteria: [
		{ id: "C1", kind: "feature", description: "d", status: "fail", executor_status: "fail", video_ts: [0.7, 2.1], screenshot: "c1-fail.png", explanation: "e" },
		{ id: "C2", kind: "regression", description: "d", status: "blocked", executor_status: "blocked", video_ts: null, screenshot: null, explanation: "e", forced: "wall_time" },
	],
	console_errors: [{ t: 0, type: "error", text: "404", url: "http://x" }],
	network_errors: [{ t: null, method: "GET", url: "http://x/logo.svg", status: 404 }],
	notes: "",
	stopped_because: "done",
	model: "scripted",
	usage: { requests: 3, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, usd: 0 },
	duration_s: 5.27,
}

describe("run artifacts", () => {
	it.effect("decodes and re-encodes verdict.json losslessly", () =>
		Effect.gen(function* () {
			const v = yield* Schema.decodeUnknownEffect(Verdict)(verdictJson)
			assert.deepStrictEqual(v.criteria[0]!.video_ts, Option.some([0.7, 2.1] as const))
			assert.isTrue(Option.isNone(v.criteria[1]!.screenshot))
			assert.deepStrictEqual<unknown>(yield* Schema.encodeEffect(Verdict)(v), verdictJson)
		}))

	it.effect("decodes step lines", () =>
		Effect.gen(function* () {
			const s = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Step))('{"at":1792439076447,"tool":"click_element","label":"Submit","criterion":"C1","x":1149,"y":281,"t":0.75}')
			assert.strictEqual(s.tool, "click_element")
			assert.strictEqual(s.x, 1149)
		}))
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
