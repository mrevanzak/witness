import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseSteps } from "../src/index.ts"

describe("parseSteps", () => {
	it.effect("skips blank lines and sorts by time", () =>
		Effect.gen(function* () {
			const steps = yield* parseSteps('{"at":2,"tool":"key"}\n\n{"at":1,"tool":"click","x":3}\n')
			assert.deepStrictEqual(
				steps.map((s) => s.tool),
				["click", "key"]
			)
			assert.strictEqual(steps[0]!.x, 3)
		})
	)
	it.effect("reads a navigation's HTTP status from runs that kept it in `status`", () =>
		Effect.gen(function* () {
			const [nav, end] = yield* parseSteps(
				'{"at":1,"tool":"navigate","status":200}\n{"at":2,"tool":"end_criterion","status":"pass"}'
			)
			assert.strictEqual(nav!.http_status, 200)
			assert.isUndefined(nav!.status)
			assert.strictEqual(end!.status, "pass")
		})
	)
	it.effect("fails on a malformed line or an unknown tool", () =>
		Effect.gen(function* () {
			yield* Effect.flip(parseSteps('{"at":1,"tool":"click"}\nnope'))
			yield* Effect.flip(parseSteps('{"tool":"click"}'))
			yield* Effect.flip(parseSteps('{"at":1,"tool":"rm -rf"}'))
		})
	)
})
