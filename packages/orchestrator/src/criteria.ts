// What every mode hands back once its criteria are checked (the agent, a session
// or a Playwright spec), and the verdict built from it. The overall verdict is
// code, not the model: any failure fails the run, anything unchecked blocks it.
import type { ConsoleMessage, NetworkEvent } from "@witness/computer"
import {
	aggregateOverall,
	ConsoleError,
	type Criterion,
	type CriterionStatus,
	NetworkError,
	Plan,
	type StoppedBecause,
	Usage,
	Verdict,
	VerdictCriterion,
	type WalkthroughReport,
} from "@witness/domain"
import { Option, Schema } from "effect"
import type { Usage as ModelUsage } from "./model.ts"
import { relSeconds } from "./steps.ts"

/** One criterion as it was checked. Times are computer-clock ms. */
export type CriterionRecord = {
	readonly criterion: Criterion
	readonly beganAt: number | undefined
	readonly endedAt: number | undefined
	readonly status: CriterionStatus
	readonly notes: string
	/** Full-resolution final screenshot, relative to the run dir. */
	readonly screenshot: string | undefined
	/** Set when the orchestrator, not the tester, ended the criterion. */
	readonly forced: string | undefined
	readonly console: readonly ConsoleMessage[]
	readonly network: readonly NetworkEvent[]
	/** Visible actions taken while it was active. */
	readonly steps: number
}

/** A criterion that has not begun. */
export const pendingRecord = (criterion: Criterion): CriterionRecord => ({
	beganAt: undefined,
	console: [],
	criterion,
	endedAt: undefined,
	forced: undefined,
	network: [],
	notes: "",
	screenshot: undefined,
	status: "blocked",
	steps: 0,
})

/** What a mode produced while the recording ran. */
export type ModeRun = {
	readonly summary: string
	readonly records: readonly CriterionRecord[]
	readonly console: readonly ConsoleMessage[]
	readonly network: readonly NetworkEvent[]
	readonly stoppedBecause: StoppedBecause
	/** Stills and notes for the report (sessions and specs; the agent's evidence is its screenshots). */
	readonly report: Option.Option<WalkthroughReport>
}

export const ReviewOutput = Schema.Struct({
	criteria: Schema.Array(
		Schema.Struct({
			explanation: Schema.String,
			id: Schema.String,
			status: Schema.Literals(["pass", "fail", "blocked"]),
		})
	),
	notes: Schema.String,
})
export type ReviewOutput = typeof ReviewOutput.Type

/** The tester's own statuses: the review of modes with no reviewer, and the fallback when it is unavailable. */
export const testerReview = (run: Pick<ModeRun, "records">, notes = ""): ReviewOutput => ({
	criteria: run.records.map((r) => ({ explanation: r.notes, id: r.criterion.id, status: r.status })),
	notes,
})

/** The plan a run checked: its criteria as they were declared. */
export const planOf = (run: Pick<ModeRun, "records">, summary: string) =>
	new Plan({ criteria: run.records.map((r) => r.criterion), summary })

export const noUsage: ModelUsage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, requests: 0, usd: 0 }

/** verdict.json from what the mode recorded, the review and the recording's timing. Pure. */
export const buildVerdict = (input: {
	readonly run: Pick<ModeRun, "records" | "console" | "network" | "stoppedBecause" | "summary">
	readonly review: ReviewOutput
	readonly t0: Option.Option<number>
	readonly duration: Option.Option<number>
	readonly modelId: string
	readonly usage: ModelUsage
}): Verdict => {
	const { run, review } = input
	const rel = (at: number | undefined) =>
		Option.flatMap(input.t0, (t0) => (at === undefined ? Option.none() : Option.some(Math.max(0, relSeconds(t0, at)))))
	const criteria = run.records.map((r) => {
		const c = r.criterion
		const rv = review.criteria.find((x) => x.id === c.id)
		// The orchestrator's forced "blocked" cannot be overridden by the reviewer.
		const status: CriterionStatus = r.forced ? "blocked" : (rv?.status ?? r.status)
		return new VerdictCriterion({
			description: c.description,
			executor_status: r.status,
			explanation: rv?.explanation ?? r.notes,
			id: c.id,
			kind: c.kind,
			screenshot: Option.fromUndefinedOr(r.screenshot),
			status,
			video_ts: Option.zipWith(rel(r.beganAt), rel(r.endedAt), (x, y) => [x, y] as const),
			...(r.forced ? { forced: r.forced } : {}),
		})
	})
	const t = (at: number) => Option.getOrNull(rel(at))
	const u = input.usage
	return new Verdict({
		console_errors: run.console
			.filter((m) => m.type === "error" || m.type === "pageerror")
			.map((m) => new ConsoleError({ t: t(m.at), text: m.text.slice(0, 1000), type: m.type, url: m.url })),
		criteria,
		duration_s: Option.getOrNull(input.duration),
		model: input.modelId,
		network_errors: run.network.map(
			(e) =>
				new NetworkError({
					method: e.method,
					t: t(e.at),
					url: e.url,
					...(e.status === undefined ? {} : { status: e.status }),
					...(e.error === undefined ? {} : { error: e.error }),
				})
		),
		notes: review.notes,
		overall: aggregateOverall(criteria),
		stopped_because: run.stoppedBecause,
		summary: run.summary,
		usage: new Usage({
			cache_read_tokens: u.cacheRead,
			input_tokens: u.input,
			output_tokens: u.output,
			requests: u.requests,
			usd: Math.round(u.usd * 1000) / 1000,
		}),
	})
}
