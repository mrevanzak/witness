import { homedir } from "node:os"
import { assert, describe, it } from "@effect/vitest"
import type { DeviceConfig } from "@witness/domain"
import { Effect, Option } from "effect"
import { runDevice } from "../src/verifier.ts"

const device = (app: string): DeviceConfig => ({ app, platform: "ios", services: ["store", "web"] })

describe("runDevice", () => {
	it.effect("resolves the app next to a --config file, and adds the change's services once", () =>
		Effect.gen(function* () {
			const d = yield* runDevice(device("./build/My.app"), Option.some("/work/qa"), ["photos", "web"])
			assert.deepStrictEqual([d.app, d.services], ["/work/qa/build/My.app", ["store", "web", "photos"]])
		})
	)
	it.effect("expands ~/ and keeps absolute paths", () =>
		Effect.gen(function* () {
			assert.strictEqual((yield* runDevice(device("~/My.app"), Option.none(), [])).app, `${homedir()}/My.app`)
			assert.strictEqual((yield* runDevice(device("/abs/My.app"), Option.some("/work"), [])).app, "/abs/My.app")
		})
	)
	it.effect("refuses a relative app in a repo's witness.yaml", () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(runDevice(device("./My.app"), Option.none(), []))
			assert.include(e.message, "must be an absolute path")
		})
	)
})
