import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseSteps } from "../src/steps.ts"

describe("parseSteps", () => {
	it.effect("skips blank lines and sorts by time", () =>
		Effect.gen(function* () {
			const steps = yield* parseSteps('{"at":2,"tool":"b"}\n\n{"at":1,"tool":"a","x":3}\n')
			assert.deepStrictEqual(
				steps.map((s) => s.tool),
				["a", "b"]
			)
			assert.strictEqual(steps[0]!.x, 3)
		})
	)
	it.effect("fails on a malformed line", () =>
		Effect.gen(function* () {
			yield* Effect.flip(parseSteps('{"at":1,"tool":"a"}\nnope'))
			yield* Effect.flip(parseSteps('{"tool":"a"}'))
		})
	)
})
