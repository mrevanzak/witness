import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { Artifacts, makeArtifacts } from "../src/server/artifacts.ts"
import { makeExec } from "../src/server/exec.ts"

/** An Exec over a fresh artifacts dir, as a device run builds it on the host. */
const hostExec = (scope: Scope.Scope, keepSpawned = false) =>
	Effect.gen(function* () {
		const root = mkdtempSync(join(tmpdir(), "witness-exec-"))
		const files = yield* makeArtifacts(root)
		const exec = yield* makeExec({ cwd: root, env: { GREETING: "hi" }, keepSpawned, shell: ["sh", "-c"] }).pipe(
			Effect.provideService(Artifacts, files),
			Scope.provide(scope)
		)
		return { exec, files, root }
	})

describe("makeExec on the host", () => {
	it.live("runs in its cwd with only its env, and keeps logs under the artifacts", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			const { exec, files } = yield* hostExec(scope)
			const r = yield* exec.run({ cmd: 'echo "$GREETING"; printenv HOME || echo no-home' })
			assert.strictEqual(r.stdout, "hi\nno-home\n")
			const escaped = yield* Effect.flip(exec.spawn({ cmd: "true", log: "../escape.log" }))
			assert.strictEqual(escaped._tag, "ArtifactPathError")
			const outside = yield* Effect.flip(files.tail("../../etc/hosts", 1))
			assert.strictEqual(outside._tag, "ArtifactPathError")
			yield* Scope.close(scope, Exit.void)
		}).pipe(Effect.provide(NodeServices.layer))
	)

	it.live("stops what it spawned when the scope closes", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			const { exec, root } = yield* hostExec(scope)
			const marker = join(root, "still-running")
			yield* exec.spawn({ cmd: `sleep 1; touch ${marker}`, log: "app.log" })
			yield* Effect.sleep("200 millis")
			assert.isTrue(existsSync(join(root, "app.log")))
			yield* Scope.close(scope, Exit.void)
			yield* Effect.sleep("1500 millis")
			assert.isFalse(existsSync(marker))
		}).pipe(Effect.provide(NodeServices.layer))
	)

	it.live("leaves what it spawned running when the run is kept", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			const { exec, root } = yield* hostExec(scope, true)
			const marker = join(root, "still-running")
			yield* exec.spawn({ cmd: `sleep 1; touch ${marker}`, log: "app.log" })
			yield* Scope.close(scope, Exit.void)
			yield* Effect.sleep("1500 millis")
			assert.isTrue(existsSync(marker))
		}).pipe(Effect.provide(NodeServices.layer))
	)
})
