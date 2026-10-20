import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { configSecrets, parseEnvFile, parseWitnessConfig } from "../src/index.ts"

const FULL = `
setup:
  - pnpm install --frozen-lockfile
  - pnpm db:migrate && pnpm db:seed
start: pnpm dev --port 3000
url: http://localhost:3000
health: http://localhost:3000/api/health
services:
  postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: test }, port: 5432 }
  cache: { image: redis:7, command: redis-server --save "" }
env:
  DATABASE_URL: postgres://postgres:test@postgres:5432/postgres
  PORT: 3000
login:
  email: qa@example.com
  password: qa-password
`

const failsWith = (text: string, tag: string, pattern: RegExp) =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(parseWitnessConfig(text))
		assert.strictEqual(error._tag, tag)
		assert.match(error.message, pattern)
	})

describe("parseWitnessConfig", () => {
	it.effect("decodes the full example with defaults applied", () =>
		Effect.gen(function* () {
			const c = yield* parseWitnessConfig(FULL)
			assert.deepStrictEqual(c.setup, ["pnpm install --frozen-lockfile", "pnpm db:migrate && pnpm db:seed"])
			assert.strictEqual(c.health, "http://localhost:3000/api/health")
			assert.deepStrictEqual(c.services.postgres, {
				env: { POSTGRES_PASSWORD: "test" },
				image: "postgres:16",
				port: 5432,
			})
			assert.deepStrictEqual(c.services.cache?.command, ["sh", "-c", 'redis-server --save ""'])
			assert.strictEqual(c.env.PORT, "3000")
			assert.deepStrictEqual(c.timeouts, { bootSec: 180, setupSec: 900 })
			assert.deepStrictEqual(configSecrets(c), ["qa-password"])
			assert.isTrue(Option.isNone(c.secretEnv))
		})
	)

	it.effect("defaults health to url and accepts a single setup string", () =>
		Effect.gen(function* () {
			const c = yield* parseWitnessConfig("setup: npm ci\nstart: npm start\nurl: http://localhost:8080/app\n")
			assert.deepStrictEqual(c.setup, ["npm ci"])
			assert.strictEqual(c.health, "http://localhost:8080/app")
			assert.isTrue(Option.isNone(c.login))
			assert.deepStrictEqual(configSecrets(c), [])
		})
	)

	it.effect("reads the evidence destination", () =>
		Effect.gen(function* () {
			const c = yield* parseWitnessConfig("start: x\nurl: http://localhost:3000\nevidence: hosted\n")
			assert.deepStrictEqual(c.evidence, Option.some("hosted"))
			const none = yield* parseWitnessConfig("start: x\nurl: http://localhost:3000\n")
			assert.isTrue(Option.isNone(none.evidence))
		})
	)
	it.effect("rejects an unknown evidence destination", () =>
		failsWith("start: x\nurl: http://localhost:3000\nevidence: slack\n", "ConfigInvalidError", /evidence/)
	)

	it.effect("records before and after unless states says after", () =>
		Effect.gen(function* () {
			const byDefault = yield* parseWitnessConfig("start: x\nurl: http://localhost:3000\n")
			assert.strictEqual(byDefault.states, "before-after")
			const after = yield* parseWitnessConfig("start: x\nurl: http://localhost:3000\nstates: after\n")
			assert.strictEqual(after.states, "after")
		})
	)
	it.effect("rejects unknown states", () =>
		failsWith("start: x\nurl: http://localhost:3000\nstates: before\n", "ConfigInvalidError", /states/)
	)

	it.effect("rejects invalid YAML", () => failsWith("start: [unclosed", "ConfigParseError", /not valid YAML/))
	it.effect("requires url", () => failsWith("start: x", "ConfigInvalidError", /url/))
	it.effect("requires start", () => failsWith("url: http://a", "ConfigInvalidError", /start/))
	it.effect("rejects non-http urls", () =>
		failsWith("start: x\nurl: localhost:3000", "ConfigInvalidError", /http\(s\) URL/)
	)
	it.effect("rejects unknown keys", () =>
		failsWith("start: x\nurl: http://a\nsetpu: [x]", "ConfigInvalidError", /setpu/)
	)
	it.effect("rejects bad service names", () =>
		failsWith("start: x\nurl: http://a\nservices: { Bad_Name: { image: x } }", "ConfigInvalidError", /Bad_Name/)
	)
	it.effect("rejects out-of-range ports", () =>
		failsWith(
			"start: x\nurl: http://a\nservices: { db: { image: x, port: 99999 } }",
			"ConfigInvalidError",
			/port|65535/
		)
	)
	it.effect("rejects invalid env names", () =>
		failsWith("start: x\nurl: http://a\nenv: { 'A-B': c }", "ConfigInvalidError", /A-B/)
	)
	it.effect("rejects non-positive timeouts", () =>
		failsWith("start: x\nurl: http://a\ntimeouts: { boot: -1 }", "ConfigInvalidError", /0/)
	)
	it.effect("rejects file destinations outside the app", () =>
		failsWith("start: x\nurl: http://a\nfiles: { '../x': ./y }", "ConfigInvalidError", /relative to the app/)
	)
})

describe("parseEnvFile", () => {
	it("reads quoted values, comments and export prefixes", () => {
		assert.deepStrictEqual(parseEnvFile("# c\nexport A=\"1\"\nB=two\n\nC='x=y'\nbad line\n"), {
			A: "1",
			B: "two",
			C: "x=y",
		})
	})
})
