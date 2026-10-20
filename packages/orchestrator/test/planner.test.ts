import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { normalizePlan } from "../src/planner.ts"

const c = (kind: "feature" | "regression", id = "X") => ({
	description: "d",
	evidence: "e",
	how_to_check: "h",
	id,
	kind,
})

describe("normalizePlan", () => {
	it.effect("renumbers ids and caps at 6", () =>
		Effect.gen(function* () {
			const p = yield* normalizePlan({
				criteria: [c("feature"), c("regression"), c("feature"), c("feature"), c("feature"), c("feature"), c("feature")],
				summary: " s ",
			})
			assert.deepStrictEqual(
				p.criteria.map((x) => x.id),
				["C1", "C2", "C3", "C4", "C5", "C6"]
			)
			assert.strictEqual(p.summary, "s")
		})
	)
	it.effect("requires a regression criterion", () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(normalizePlan({ criteria: [c("feature"), c("feature")], summary: "" }))
			assert.match(e.message, /regression/)
		})
	)
	it.effect("requires at least two criteria", () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(normalizePlan({ criteria: [c("regression")], summary: "" }))
			assert.match(e.message, /need 2 to 6/)
		})
	)
})
