// Deterministic end-to-end check of the whole pipeline without an API key: a
// scripted Model drives the real computer through the todo-app fixture branches.
//   pnpm e2e:scripted [ref]   -> feat/empty-title = pass, feat/empty-title-broken = fail
// It exercises boot, recording, the tool loop, steps.jsonl, evidence and verdict.json;
// it does not test the model's judgment (that is the live acceptance).
// SCRIPTED_DELAY_MS simulates model latency so the renderer gets realistic idle time.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { DockerComputerProvider } from "@witness/computer"
import { Plan } from "@witness/domain"
import { Config, Effect, Layer, Option, Path, Ref, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Git, Model, type ModelMessage, type ModelRequest, ReviewOutput, runLayer, verify } from "../src/index.ts"

const PLAN = new Plan({
	summary: "Empty titles must be rejected with an inline error; adding a normal todo must keep working.",
	criteria: [
		{ id: "C1", kind: "feature", description: "Submitting an empty title shows 'Title is required' and adds nothing", how_to_check: "Click Add todo with the input empty", evidence: "Error text under the input; count stays at 2 items left" },
		{ id: "C2", kind: "regression", description: "Adding a normal todo still works", how_to_check: "Type 'Buy bread' and click Add todo", evidence: "'Buy bread' appears in the list" },
	],
})

type ToolCall = { readonly name: string; readonly input: Record<string, unknown> }

const lastSnapshot = (req: ModelRequest): string => {
	for (const m of [...req.messages].reverse()) {
		if (m.role !== "user" || typeof m.content === "string") continue
		for (const b of m.content) {
			if (b.type !== "tool_result" || !Array.isArray(b.content)) continue
			for (const c of b.content) if (c.type === "text" && c.text.startsWith("URL:")) return c.text
		}
	}
	return ""
}

const ref = (snap: string, pattern: RegExp) => snap.split("\n").find((l) => /^e\d+ /.test(l) && pattern.test(l))?.split(" ")[0] ?? "missing"

const message = (step: number, tools: ReadonlyArray<ToolCall>, text?: string): ModelMessage =>
	({
		id: `msg_${step}`,
		type: "message",
		role: "assistant",
		model: "scripted",
		content: [...(text ? [{ type: "text", text, citations: null }] : []), ...tools.map((t, i) => ({ type: "tool_use", id: `tu_${step}_${i}`, name: t.name, input: t.input, caller: { type: "direct" } }))],
		stop_reason: tools.length ? "tool_use" : "end_turn",
		usage: { input_tokens: 0, output_tokens: 0 },
	}) as unknown as ModelMessage // a hand-built SDK message for the scripted model only

/** Plays a fixed QA script; decisions read the latest page_snapshot text. */
const ScriptedModel = Layer.effect(
	Model,
	Effect.gen(function* () {
		const delay = yield* Config.Int("SCRIPTED_DELAY_MS").pipe(Config.withDefault(0))
		const step = yield* Ref.make(0)
		const create = (req: ModelRequest) =>
			Effect.gen(function* () {
				const s = yield* Ref.getAndUpdate(step, (n) => n + 1)
				if (delay) yield* Effect.sleep(`${Math.round(delay * (0.6 + ((s * 37) % 10) / 12.5))} millis`)
				const snap = lastSnapshot(req)
				const calls: Record<number, () => ModelMessage> = {
					0: () => message(s, [{ name: "begin_criterion", input: { id: "C1" } }, { name: "page_snapshot", input: {} }]),
					1: () => message(s, [{ name: "click_element", input: { ref: ref(snap, /"Add todo"/), label: "Submit with an empty title" } }]),
					2: () => message(s, [{ name: "wait", input: { ms: 800, label: "Wait for the list to update" } }, { name: "page_snapshot", input: {} }]),
					3: () => {
						const error = snap.includes("Title is required")
						const count = snap.match(/(\d+) items? left/)?.[1]
						const status = error && count === "2" ? "pass" : "fail"
						return message(s, [{ name: "end_criterion", input: { id: "C1", status, notes: `Error text ${error ? "shown" : "not shown"}; counter says ${count} items left (was 2).` } }])
					},
					4: () => message(s, [{ name: "begin_criterion", input: { id: "C2" } }, { name: "page_snapshot", input: {} }]),
					5: () => message(s, [{ name: "click_element", input: { ref: ref(snap, /textbox|input/), label: "Focus the title field" } }, { name: "type", input: { text: "Buy bread", label: "Type 'Buy bread'" } }]),
					6: () => message(s, [{ name: "key", input: { combo: "Return", label: "Press Enter to add" } }]),
					7: () => message(s, [{ name: "wait", input: { ms: 800, label: "Wait for the new todo" } }, { name: "page_snapshot", input: {} }]),
					8: () => {
						const ok = snap.includes("Buy bread")
						return message(s, [{ name: "end_criterion", input: { id: "C2", status: ok ? "pass" : "fail", notes: ok ? "'Buy bread' is in the list." : "'Buy bread' did not appear." } }])
					},
				}
				return (calls[s] ?? (() => message(s, [], "Checked both criteria.")))()
			})
		const parse = <A, I>(req: ModelRequest, schema: Schema.Codec<A, I>) =>
			Effect.gen(function* () {
				if (typeof req.system === "string" && req.system.includes("planning stage")) {
					yield* Ref.set(step, 0) // a new run starts the script again
					return Option.some(yield* Schema.decodeUnknownEffect(schema)(Schema.encodeSync(Plan)(PLAN)).pipe(Effect.orDie))
				}
				// Reviewer: echo the tester's statuses from the prompt.
				const prompt = JSON.stringify(req.messages)
				const review: typeof ReviewOutput.Type = {
					criteria: [...prompt.matchAll(/## (C\d)[^#]*?Tester status: (pass|fail|blocked)/g)].map((m) => ({ id: m[1]!, status: m[2]! as "pass" | "fail" | "blocked", explanation: `Scripted review of ${m[1]}.` })),
					notes: "",
				}
				return Option.some(yield* Schema.decodeUnknownEffect(schema)(review).pipe(Effect.orDie))
			})
		return Model.of({ id: "scripted", usage: Effect.succeed({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }), create, parse })
	})
)

const program = Effect.gen(function* () {
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const root = path.resolve(import.meta.dirname, "../../..")
	const fixture = (yield* spawner.string(ChildProcess.make("bash", [path.join(root, "examples/todo-app/make-fixture.sh")]))).trim()
	const only = process.argv[2]
	const cases = [
		{ ref: "feat/empty-title", expect: "pass" },
		{ ref: "feat/empty-title-broken", expect: "fail" },
	].filter((c) => !only || c.ref === only)

	let failed = 0
	for (const c of cases) {
		const outcome = yield* verify({
			repo: fixture,
			ref: c.ref,
			base: Option.some("main"),
			task: "Validate empty todo titles",
			runsDir: path.join(root, "runs"),
			mode: { _tag: "Agent" },
			configPath: Option.none(),
			context: Option.none(),
			keep: false,
			enableVnc: false,
			memoryGb: 4,
			cpus: 2,
		}).pipe(Effect.provide(runLayer(path.join(root, "runs")).agent))
		const ok = outcome.overall === c.expect
		if (!ok) failed++
		const detail = Option.match(outcome.verdict, {
			onNone: () => Option.match(outcome.blocked, { onNone: () => "", onSome: (b) => `${b.reason}: ${b.message}` }),
			onSome: (v) => v.criteria.map((x) => `${x.id}=${x.status} ${JSON.stringify(Option.getOrNull(x.video_ts))}`).join(" "),
		})
		yield* Effect.logInfo(`${ok ? "OK  " : "FAIL"} ${c.ref}: ${outcome.overall} (expected ${c.expect}) ${detail} ${outcome.runDir}`)
	}
	if (failed) return yield* Effect.die(`${failed} case(s) did not match`)
})

program.pipe(
	Effect.provide(Layer.mergeAll(Git.layer, DockerComputerProvider, ScriptedModel).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)))),
	NodeRuntime.runMain
)
