// The step log: one line per tool call or walkthrough action. `at` is wall-clock
// ms on the computer's clock; `t` (seconds into raw.mp4) is filled in once the
// recording stops and its first-frame time t0 is known.
import { RUN_FILES, redactDeep, Step } from "@witness/domain"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { CurrentRun, type RunWriteError } from "./current-run.ts"

export type StepInput = ConstructorParameters<typeof Step>[0]

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Step))

/** Seconds from `t0` to `at` (both computer-clock ms), rounded to `digits` decimals. */
export const relSeconds = (t0: number, at: number, digits = 1) => {
	const k = 10 ** digits
	return Math.round(((at - t0) / 1000) * k) / k
}

export class Steps extends Context.Service<
	Steps,
	{
		add: (step: StepInput) => Effect.Effect<Step, RunWriteError>
		/** Rewrites steps.jsonl with `t` relative to the first video frame (or the first step). */
		finalize: (t0: Option.Option<number>) => Effect.Effect<readonly Step[], RunWriteError>
	}
>()("witness/orchestrator/Steps") {
	static readonly layer = Layer.effect(
		Steps,
		Effect.gen(function* () {
			const run = yield* CurrentRun
			const steps = yield* Ref.make<readonly Step[]>([])

			const add = Effect.fn("Steps.add")(function* (input: StepInput) {
				const clean = new Step(redactDeep(input, yield* run.secrets))
				yield* Ref.update(steps, (s) => [...s, clean])
				yield* run.appendText(RUN_FILES.steps, `${encodeLine(clean)}\n`)
				yield* run.publish({ step: Schema.encodeSync(Step)(clean), type: "step" })
				return clean
			})

			const finalize = Effect.fn("Steps.finalize")(function* (t0: Option.Option<number>) {
				const current = yield* Ref.get(steps)
				const base = Option.getOrElse(t0, () => current[0]?.at ?? 0)
				const timed = current.map((s) => new Step({ ...s, t: relSeconds(base, s.at, 2) }))
				yield* Ref.set(steps, timed)
				yield* run.writeText(RUN_FILES.steps, timed.map((s) => `${encodeLine(s)}\n`).join(""))
				return timed
			})

			return Steps.of({ add, finalize })
		})
	)
}
