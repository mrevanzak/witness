// pnpm render:run runs/<id> [--label after]
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { renderRun } from "../src/index.ts"

const [dir, flag, label] = process.argv.slice(2)
Effect.gen(function* () {
	if (!dir) {
		return yield* Console.error("usage: render.ts <runDir> [--label <text>]")
	}
	const r = yield* renderRun(dir, { ...(flag === "--label" && label ? { label } : {}) })
	yield* Console.log(
		`polished.mp4 ${r.durationSec.toFixed(1)} s (${r.timeline.segments.length} segments) + preview.gif -> ${r.polished}`
	)
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
