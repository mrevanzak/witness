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
import { Git, Model, type ModelMessage, type ModelRequest, type ReviewOutput, runLayer, verify } from "../src/index.ts"

const PLAN = new Plan({
	criteria: [
		{
			description: "Submitting an empty title shows 'Title is required' and adds nothing",
			evidence: "Error text under the input; count stays at 2 items left",
			how_to_check: "Click Add todo with the input empty",
			id: "C1",
			kind: "feature",
		},
		{
			description: "Adding a normal todo still works",
			evidence: "'Buy bread' appears in the list",
			how_to_check: "Type 'Buy bread' and click Add todo",
			id: "C2",
			kind: "regression",
		},
	],
	summary: "Empty titles must be rejected with an inline error; adding a normal todo must keep working.",
})

type ToolCall = { readonly name: string; readonly input: Record<string, unknown> }

const lastSnapshot = (req: ModelRequest): string => {
	for (const m of [...req.messages].reverse()) {
		if (m.role !== "user" || typeof m.content === "string") {
			continue
		}
		for (const b of m.content) {
			if (b.type !== "tool_result" || !Array.isArray(b.content)) {
				continue
			}
			for (const c of b.content) {
				if (c.type === "text" && c.text.startsWith("URL:")) {
					return c.text
				}
			}
		}
	}
	return ""
}

const ref = (snap: string, pattern: RegExp) =>
	snap
		.split("\n")
		.find((l) => /^e\d+ /.test(l) && pattern.test(l))
		?.split(" ")[0] ?? "missing"

const message = (step: number, tools: readonly ToolCall[], text?: string): ModelMessage =>
	({
		content: [
			...(text ? [{ citations: null, text, type: "text" }] : []),
			...tools.map((t, i) => ({
				caller: { type: "direct" },
				id: `tu_${step}_${i}`,
				input: t.input,
				name: t.name,
				type: "tool_use",
			})),
		],
		id: `msg_${step}`,
		model: "scripted",
		role: "assistant",
		stop_reason: tools.length ? "tool_use" : "end_turn",
		type: "message",
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
				if (delay) {
					yield* Effect.sleep(`${Math.round(delay * (0.6 + ((s * 37) % 10) / 12.5))} millis`)
				}
				const snap = lastSnapshot(req)
				const calls: Record<number, () => ModelMessage> = {
					0: () =>
						message(s, [
							{ input: { id: "C1" }, name: "begin_criterion" },
							{ input: {}, name: "page_snapshot" },
						]),
					1: () =>
						message(s, [
							{ input: { label: "Submit with an empty title", ref: ref(snap, /"Add todo"/) }, name: "click_element" },
						]),
					2: () =>
						message(s, [
							{ input: { label: "Wait for the list to update", ms: 800 }, name: "wait" },
							{ input: {}, name: "page_snapshot" },
						]),
					3: () => {
						const error = snap.includes("Title is required")
						const count = snap.match(/(\d+) items? left/)?.[1]
						const status = error && count === "2" ? "pass" : "fail"
						return message(s, [
							{
								input: {
									id: "C1",
									notes: `Error text ${error ? "shown" : "not shown"}; counter says ${count} items left (was 2).`,
									status,
								},
								name: "end_criterion",
							},
						])
					},
					4: () =>
						message(s, [
							{ input: { id: "C2" }, name: "begin_criterion" },
							{ input: {}, name: "page_snapshot" },
						]),
					5: () =>
						message(s, [
							{ input: { label: "Focus the title field", ref: ref(snap, /textbox|input/) }, name: "click_element" },
							{ input: { label: "Type 'Buy bread'", text: "Buy bread" }, name: "type" },
						]),
					6: () => message(s, [{ input: { combo: "Return", label: "Press Enter to add" }, name: "key" }]),
					7: () =>
						message(s, [
							{ input: { label: "Wait for the new todo", ms: 800 }, name: "wait" },
							{ input: {}, name: "page_snapshot" },
						]),
					8: () => {
						const ok = snap.includes("Buy bread")
						return message(s, [
							{
								input: {
									id: "C2",
									notes: ok ? "'Buy bread' is in the list." : "'Buy bread' did not appear.",
									status: ok ? "pass" : "fail",
								},
								name: "end_criterion",
							},
						])
					},
				}
				return (calls[s] ?? (() => message(s, [], "Checked both criteria.")))()
			})
		const parse = <A, I>(req: ModelRequest, schema: Schema.Codec<A, I>) =>
			Effect.gen(function* () {
				if (typeof req.system === "string" && req.system.includes("planning stage")) {
					yield* Ref.set(step, 0) // a new run starts the script again
					return Option.some(
						yield* Schema.decodeUnknownEffect(schema)(Schema.encodeSync(Plan)(PLAN)).pipe(Effect.orDie)
					)
				}
				// Reviewer: echo the tester's statuses from the prompt.
				const prompt = JSON.stringify(req.messages)
				const review: typeof ReviewOutput.Type = {
					criteria: [...prompt.matchAll(/## (C\d)[^#]*?Tester status: (pass|fail|blocked)/g)].map((m) => ({
						explanation: `Scripted review of ${m[1]}.`,
						id: m[1]!,
						status: m[2]! as "pass" | "fail" | "blocked",
					})),
					notes: "",
				}
				return Option.some(yield* Schema.decodeUnknownEffect(schema)(review).pipe(Effect.orDie))
			})
		return Model.of({
			create,
			id: "scripted",
			parse,
			usage: Effect.succeed({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0, requests: 0, usd: 0 }),
		})
	})
)

const program = Effect.gen(function* () {
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const root = path.resolve(import.meta.dirname, "../../..")
	const fixture = (yield* spawner.string(
		ChildProcess.make("bash", [path.join(root, "examples/todo-app/make-fixture.sh")])
	)).trim()
	const only = process.argv[2]
	const cases = [
		{ expect: "pass", ref: "feat/empty-title" },
		{ expect: "fail", ref: "feat/empty-title-broken" },
	].filter((c) => !only || c.ref === only)

	let failed = 0
	for (const c of cases) {
		const outcome = yield* verify({
			base: Option.some("main"),
			configPath: Option.none(),
			context: Option.none(),
			cpus: 2,
			enableVnc: false,
			keep: false,
			memoryGb: 4,
			mode: { _tag: "Agent" },
			ref: c.ref,
			repo: fixture,
			runsDir: path.join(root, "runs"),
			task: "Validate empty todo titles",
		}).pipe(Effect.provide(runLayer(path.join(root, "runs")).agent))
		const ok = outcome.overall === c.expect
		if (!ok) {
			failed += 1
		}
		const detail = Option.match(outcome.verdict, {
			onNone: () => Option.match(outcome.blocked, { onNone: () => "", onSome: (b) => `${b.reason}: ${b.message}` }),
			onSome: (v) =>
				v.criteria.map((x) => `${x.id}=${x.status} ${JSON.stringify(Option.getOrNull(x.video_ts))}`).join(" "),
		})
		yield* Effect.logInfo(
			`${ok ? "OK  " : "FAIL"} ${c.ref}: ${outcome.overall} (expected ${c.expect}) ${detail} ${outcome.runDir}`
		)
	}
	if (failed) {
		return yield* Effect.die(`${failed} case(s) did not match`)
	}
})

program.pipe(
	Effect.provide(
		Layer.mergeAll(Git.layer, DockerComputerProvider, ScriptedModel).pipe(
			Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
		)
	),
	NodeRuntime.runMain
)
