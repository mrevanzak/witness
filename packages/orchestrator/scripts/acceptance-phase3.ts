// Live acceptance: the real model must return `pass` for the correct branch and
// `fail` for the broken one in at least 4 of 5 runs each, with sane timestamps.
//   ANTHROPIC_API_KEY=... pnpm acceptance:phase3 [runsPerBranch=5]
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { DockerComputerProvider } from "@witness/computer"
import { Console, Effect, Layer, Option, Path, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Git, Model, runLayer, verify } from "../src/index.ts"

class AcceptanceFailed extends Schema.TaggedError<AcceptanceFailed>()("AcceptanceFailed", { message: Schema.String }) {}

const TASK =
	"Adding a todo with an empty or whitespace-only title should show 'Title is required' under the input and must not add the todo."

const program = Effect.gen(function* () {
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const root = path.resolve(import.meta.dirname, "../../..")
	const n = Number(process.argv[2] ?? 5)
	const fixture = (yield* spawner.string(
		ChildProcess.make("bash", [path.join(root, "examples/todo-app/make-fixture.sh")])
	)).trim()
	const runsDir = path.join(root, "runs")
	let ok = true
	let usd = 0
	for (const b of [
		{ expect: "pass", ref: "feat/empty-title" },
		{ expect: "fail", ref: "feat/empty-title-broken" },
	] as const) {
		let hits = 0
		for (let i = 1; i <= n; i++) {
			const out = yield* verify({
				base: Option.some("main"),
				configPath: Option.none(),
				context: Option.none(),
				cpus: 2,
				enableVnc: false,
				keep: false,
				memoryGb: 4,
				mode: { _tag: "Agent" },
				ref: b.ref,
				repo: fixture,
				runsDir,
				task: TASK,
			}).pipe(Effect.provide(runLayer(runsDir).agent.pipe(Layer.provideMerge(Model.claude))))
			const v = Option.getOrUndefined(out.verdict)
			usd += v?.usage.usd ?? 0
			const tsOk =
				!!v &&
				v.criteria.every((c) =>
					Option.match(c.video_ts, { onNone: () => true, onSome: ([a, z]) => a <= z && z <= (v.duration_s ?? 0) + 1 })
				)
			const failTs =
				b.expect !== "fail" || (v?.criteria.some((c) => c.status === "fail" && Option.isSome(c.video_ts)) ?? false)
			const hit = out.overall === b.expect && tsOk && failTs
			if (hit) {
				hits += 1
			}
			yield* Console.log(
				`${b.ref} #${i}: ${out.overall}${hit ? "" : "  <-- miss"}  ${v?.criteria.map((c) => `${c.id}=${c.status}`).join(" ") ?? ""}  $${v?.usage.usd.toFixed(2) ?? "?"}  ${out.runDir}`
			)
		}
		const pass = hits >= Math.ceil(n * 0.8)
		ok &&= pass
		yield* Console.log(`=> ${b.ref}: ${hits}/${n} ${pass ? "OK" : "NOT OK"}\n`)
	}
	yield* Console.log(`total model spend ≈ $${usd.toFixed(2)}`)
	if (!ok) {
		return yield* new AcceptanceFailed({ message: "live acceptance failed" })
	}
})

program.pipe(
	Effect.provide(
		Layer.mergeAll(Git.layer, DockerComputerProvider).pipe(
			Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
		)
	),
	NodeRuntime.runMain
)
