// The step log: one line per tool call or walkthrough action. `at` is wall-clock
// ms on the computer's clock; `t` (seconds into raw.mp4) is filled in once the
// recording stops and its first-frame time t0 is known.
import { redactDeep, Step } from "@witness/domain"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { CurrentRun, type RunWriteError } from "./CurrentRun.ts"

export type StepInput = ConstructorParameters<typeof Step>[0]

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Step))

export class Steps extends Context.Service<
	Steps,
	{
		add(step: StepInput): Effect.Effect<Step, RunWriteError>
		readonly all: Effect.Effect<ReadonlyArray<Step>>
		/** Rewrites steps.jsonl with `t` relative to the first video frame (or the first step). */
		finalize(t0: Option.Option<number>): Effect.Effect<ReadonlyArray<Step>, RunWriteError>
	}
>()("witness/orchestrator/Steps") {
	static readonly layer = Layer.effect(
		Steps,
		Effect.gen(function* () {
			const run = yield* CurrentRun
			const steps = yield* Ref.make<ReadonlyArray<Step>>([])
			yield* run.writeText("steps.jsonl", "")

			const write = (all: ReadonlyArray<Step>) => run.writeText("steps.jsonl", all.map((s) => encodeLine(s)).join("\n") + (all.length ? "\n" : ""))

			const add = Effect.fn("Steps.add")(function* (input: StepInput) {
				const clean = new Step(redactDeep(input, yield* run.secrets))
				const all = yield* Ref.updateAndGet(steps, (s) => [...s, clean])
				yield* write(all)
				yield* run.publish({ type: "step", step: Schema.encodeSync(Step)(clean) })
				return clean
			})

			const finalize = Effect.fn("Steps.finalize")(function* (t0: Option.Option<number>) {
				const current = yield* Ref.get(steps)
				const base = Option.getOrElse(t0, () => current[0]?.at ?? 0)
				const timed = current.map((s) => new Step({ ...s, t: Math.round(((s.at - base) / 1000) * 100) / 100 }))
				yield* Ref.set(steps, timed)
				yield* write(timed)
				return timed
			})

			return Steps.of({ add, all: Ref.get(steps), finalize })
		})
	)
}

/** Parses a steps.jsonl file's text (blank lines skipped), sorted by time. */
export const parseSteps = (text: string) =>
	Effect.forEach(
		text.split("\n").filter((l) => l.trim()),
		(line) => Schema.decodeUnknownEffect(Schema.fromJsonString(Step))(line)
	).pipe(Effect.map((steps) => [...steps].sort((a, b) => a.at - b.at)))
