import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { normalizePlan } from "../src/planner.ts"

const c = (kind: "feature" | "regression", id = "X") => ({ id, kind, description: "d", how_to_check: "h", evidence: "e" })

describe("normalizePlan", () => {
	it.effect("renumbers ids and caps at 6", () =>
		Effect.gen(function* () {
			const p = yield* normalizePlan({ summary: " s ", criteria: [c("feature"), c("regression"), c("feature"), c("feature"), c("feature"), c("feature"), c("feature")] })
			assert.deepStrictEqual(p.criteria.map((x) => x.id), ["C1", "C2", "C3", "C4", "C5", "C6"])
			assert.strictEqual(p.summary, "s")
		}))
	it.effect("requires a regression criterion", () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(normalizePlan({ summary: "", criteria: [c("feature"), c("feature")] }))
			assert.match(e.message, /regression/)
		}))
	it.effect("requires at least two criteria", () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(normalizePlan({ summary: "", criteria: [c("regression")] }))
			assert.match(e.message, /need 2 to 6/)
		}))
})
