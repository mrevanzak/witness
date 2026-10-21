// Session mode: a program fed command by command (by `witness act`, from the
// coding agent the user already runs) drives the recorder instead of the model.
// It records the same steps, stills and verdict as the agent.
import type { Computer } from "@witness/computer"
import { type Criterion, redact, WalkthroughReport, type WitnessConfig } from "@witness/domain"
import { Effect, Option } from "effect"
import type { ModeRun } from "./criteria.ts"
import { CurrentRun } from "./current-run.ts"
import { type ActionFailed, makeRecorder, Recorder } from "./recorder.ts"

/** Screenshots a session's driver sees are this wide; its coordinates are in these pixels. */
export const SESSION_SHOT_WIDTH = 1280

/** Which commit a session is on, and the criteria it starts with. */
export type SessionSide = {
	/** The base commit or the change of a before/after; absent for a single run. */
	readonly state: Option.Option<"before" | "after">
	readonly sha: string
	/** Criteria declared on the base commit, to check again on the change. */
	readonly carried: readonly Criterion[]
}

/** Serves one side's commands over the recorder until the driver finishes it. */
export type SessionProgram = (side: SessionSide) => Effect.Effect<void, ActionFailed, Recorder>

/** Runs `program` over a recorder for this side. A program that fails leaves its open criteria blocked. */
export const runSession = Effect.fn("runSession")(function* (
	computer: Computer,
	config: WitnessConfig,
	program: SessionProgram,
	side: SessionSide
) {
	const run = yield* CurrentRun
	const secrets = yield* run.secrets
	for (const c of side.carried) {
		yield* run.log("criterion.declared", { description: c.description, id: c.id, kind: c.kind })
	}
	const recorder = yield* makeRecorder(computer, config, side.carried, SESSION_SHOT_WIDTH)
	const outcome = yield* program(side).pipe(Effect.provideService(Recorder, recorder), Effect.result)
	const error =
		outcome._tag === "Failure"
			? Option.some(redact(outcome.failure.message, secrets).slice(0, 500))
			: Option.none<string>()
	if (Option.isSome(error)) {
		yield* run.log("session.error", { message: error.value })
	}

	const recorded = yield* recorder.finish(
		"session",
		Option.match(error, { onNone: () => "not reached in the session", onSome: (m) => `session stopped: ${m}` })
	)
	return {
		...recorded,
		report: Option.some(
			new WalkthroughReport({
				...recorded.report,
				notes: Option.match(error, {
					onNone: () => recorded.report.notes,
					onSome: (m) => [...recorded.report.notes, `Session error: ${m}`],
				}),
			})
		),
		stoppedBecause: Option.isSome(error) ? "error" : "done",
		summary: "",
	} satisfies ModeRun
})
