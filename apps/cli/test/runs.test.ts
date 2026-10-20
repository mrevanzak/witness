import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Git } from "@witness/orchestrator"
import { Effect, Layer } from "effect"
import { witnessHome } from "../src/runs.ts"

const services = Git.layer.pipe(Layer.provideMerge(NodeServices.layer))
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "witness-runs-")))

describe("witnessHome", () => {
	it.effect("is .witness at the git root, and ignores itself", () =>
		Effect.gen(function* () {
			const root = tempDir()
			execFileSync("git", ["init", "-q"], { cwd: root })
			mkdirSync(join(root, "apps", "web"), { recursive: true })
			const home = yield* witnessHome(join(root, "apps", "web"))
			assert.strictEqual(home, join(root, ".witness"))
			mkdirSync(join(home, "runs", "r1"), { recursive: true })
			writeFileSync(join(home, "runs", "r1", "verdict.json"), "{}")
			assert.strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "")
		}).pipe(Effect.provide(services))
	)
	it.effect("is .witness in the directory itself outside a repo", () =>
		Effect.gen(function* () {
			const dir = tempDir()
			const home = yield* witnessHome(dir)
			assert.strictEqual(home, join(dir, ".witness"))
			assert.include(readFileSync(join(home, ".gitignore"), "utf8").split("\n"), "*")
		}).pipe(Effect.provide(services))
	)
})
