// Run artifacts: plan.json, steps.jsonl, verdict.json, walkthrough.json and the
// manifest uploaded to the hosted viewer. Encoded shapes are the files on disk.
import { Effect, Schema } from "effect"
import { EvidenceDestination } from "./config.ts"
import { CriterionKind, CriterionStatus } from "./ids.ts"
import { EXIT_CODES } from "./verdict.ts"

/** A criterion as declared: what is checked. Sessions and specs declare these. */
export class Criterion extends Schema.Class<Criterion>("@witness/Criterion")({
	description: Schema.String,
	id: Schema.String,
	kind: CriterionKind,
}) {}

/** A criterion the planner wrote, with how the tester checks it and what counts as evidence. */
export class PlannedCriterion extends Criterion.extend<PlannedCriterion>("@witness/PlannedCriterion")({
	evidence: Schema.String,
	how_to_check: Schema.String,
}) {}

export class Plan extends Schema.Class<Plan>("@witness/Plan")({
	criteria: Schema.Array(Schema.Union([PlannedCriterion, Criterion])),
	summary: Schema.String,
}) {}

/** The planner's plan: every criterion says how to check it. */
export class AgentPlan extends Schema.Class<AgentPlan>("@witness/AgentPlan")({
	criteria: Schema.Array(PlannedCriterion),
	summary: Schema.String,
}) {}

/** What a step did: an action the video shows, an inspection, or a criterion/evidence marker. */
export const StepTool = Schema.Literals([
	"screenshot",
	"click",
	"double_click",
	"right_click",
	"click_element",
	"type",
	"type_secret",
	"key",
	"scroll",
	"drag",
	"navigate",
	"wait",
	"page_snapshot",
	"console_logs",
	"network_errors",
	"app_logs",
	"begin_criterion",
	"end_criterion",
	"still",
	/** A Playwright `test.step()` title (a caption only). */
	"step",
])
export type StepTool = typeof StepTool.Type

/** One line of steps.jsonl: a verifier tool call or walkthrough action. */
export class Step extends Schema.Class<Step>("@witness/Step")({
	/** Wall-clock ms on the computer's clock. */
	at: Schema.Finite,
	chars: Schema.optionalKey(Schema.Finite),
	combo: Schema.optionalKey(Schema.String),
	count: Schema.optionalKey(Schema.Finite),
	criterion: Schema.optionalKey(Schema.String),
	file: Schema.optionalKey(Schema.String),
	forced: Schema.optionalKey(Schema.String),
	/** HTTP status of a navigation. */
	http_status: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
	/** Short human caption for the video. Never contains secrets. */
	label: Schema.optionalKey(Schema.String),
	notes: Schema.optionalKey(Schema.String),
	/** How an `end_criterion` step ended its criterion. */
	status: Schema.optionalKey(CriterionStatus),
	/** Seconds since the first video frame (set once the recording stops). */
	t: Schema.optionalKey(Schema.Finite),
	tail: Schema.optionalKey(Schema.Finite),
	to_x: Schema.optionalKey(Schema.Finite),
	to_y: Schema.optionalKey(Schema.Finite),
	tool: StepTool,
	url: Schema.optionalKey(Schema.String),
	/** Screen pixels (full resolution) of the action point. */
	x: Schema.optionalKey(Schema.Finite),
	y: Schema.optionalKey(Schema.Finite),
}) {}

const decodeStep = Schema.decodeUnknownEffect(Step)

/**
 * Parses steps.jsonl text (blank lines skipped), sorted by time. Runs before
 * `http_status` existed kept a navigation's HTTP status in `status`.
 */
export const parseSteps = (text: string) =>
	Effect.forEach(
		text.split("\n").filter((l) => l.trim()),
		(line) =>
			Effect.try({
				catch: (e) => new StepsInvalid({ message: String(e) }),
				try: () => JSON.parse(line) as unknown,
			}).pipe(
				Effect.map((raw) =>
					raw && typeof raw === "object" && "status" in raw && typeof raw.status !== "string"
						? (({ status, ...rest }) => ({ ...rest, http_status: status }))(raw as { status: unknown })
						: raw
				),
				Effect.flatMap((raw) => decodeStep(raw).pipe(Effect.mapError((e) => new StepsInvalid({ message: e.message }))))
			)
	).pipe(Effect.map((steps) => [...steps].sort((a, b) => a.at - b.at)))

/** steps.jsonl has a line that is not a step. */
export class StepsInvalid extends Schema.TaggedError<StepsInvalid>()("StepsInvalid", { message: Schema.String }) {}

export const StoppedBecause = Schema.Literals([
	"done",
	"max_steps",
	"wall_time",
	"budget",
	"refusal",
	"model_gave_up",
	/** A session or walkthrough program failed. */
	"error",
])
export type StoppedBecause = typeof StoppedBecause.Type

export class VerdictCriterion extends Schema.Class<VerdictCriterion>("@witness/VerdictCriterion")({
	description: Schema.String,
	executor_status: CriterionStatus,
	explanation: Schema.String,
	forced: Schema.optionalKey(Schema.String),
	id: Schema.String,
	kind: CriterionKind,
	screenshot: Schema.OptionFromNullOr(Schema.String),
	status: CriterionStatus,
	/** [start, end] seconds into raw.mp4. */
	video_ts: Schema.OptionFromNullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
}) {}

export class ConsoleError extends Schema.Class<ConsoleError>("@witness/ConsoleError")({
	t: Schema.NullOr(Schema.Finite),
	text: Schema.String,
	type: Schema.String,
	url: Schema.String,
}) {}

export class NetworkError extends Schema.Class<NetworkError>("@witness/NetworkError")({
	error: Schema.optionalKey(Schema.String),
	method: Schema.String,
	status: Schema.optionalKey(Schema.Finite),
	t: Schema.NullOr(Schema.Finite),
	url: Schema.String,
}) {}

export class Usage extends Schema.Class<Usage>("@witness/Usage")({
	cache_read_tokens: Schema.Finite,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	requests: Schema.Finite,
	usd: Schema.Finite,
}) {}

export class Verdict extends Schema.Class<Verdict>("@witness/Verdict")({
	console_errors: Schema.Array(ConsoleError),
	criteria: Schema.Array(VerdictCriterion),
	duration_s: Schema.NullOr(Schema.Finite),
	model: Schema.String,
	network_errors: Schema.Array(NetworkError),
	notes: Schema.String,
	overall: CriterionStatus,
	stopped_because: StoppedBecause,
	summary: Schema.String,
	usage: Usage,
}) {}

/** verdict.json written when the run never reached the app (boot failure, bad config). */
export class BlockedVerdict extends Schema.Class<BlockedVerdict>("@witness/BlockedVerdict")({
	log_tail: Schema.optionalKey(Schema.String),
	notes: Schema.String,
	overall: Schema.Literal("blocked"),
	reason: Schema.String,
}) {}

/** What verdict.json holds: a verdict, or why the run never reached one. */
export const VerdictFile = Schema.Union([Verdict, BlockedVerdict])
export type VerdictFile = typeof VerdictFile.Type

/** Exit code of a run: the verdict's, or blocked. */
export const exitCodeOf = (v: VerdictFile): number => EXIT_CODES[v.overall]

export class Still extends Schema.Class<Still>("@witness/Still")({
	at: Schema.Finite,
	caption: Schema.String,
	file: Schema.String,
	t: Schema.optionalKey(Schema.Finite),
}) {}

export class WalkthroughReport extends Schema.Class<WalkthroughReport>("@witness/WalkthroughReport")({
	intro: Schema.String,
	notes: Schema.Array(Schema.String),
	preview: Schema.String,
	stills: Schema.Array(Still),
}) {}

/** How the run's evidence is rendered, from the witness.yaml it used. */
export class RenderDefaults extends Schema.Class<RenderDefaults>("@witness/RenderDefaults")({
	animation: Schema.Boolean,
	evidence: Schema.NullOr(EvidenceDestination),
}) {}

export class RunInfo extends Schema.Class<RunInfo>("@witness/RunInfo")({
	base: Schema.NullOr(Schema.String),
	id: Schema.String,
	prefix: Schema.String,
	ref: Schema.String,
	/** Absent when the run had no usable witness.yaml (and on runs from before it was recorded). */
	render: Schema.optionalKey(RenderDefaults),
	repo: Schema.String,
	sha: Schema.String,
	startedAt: Schema.String,
	task: Schema.String,
}) {}

/** A still in a report. `key` pairs a before still with its after (a still's name, or a criterion id). */
export class ReportStill extends Schema.Class<ReportStill>("@witness/ReportStill")({
	caption: Schema.String,
	file: Schema.String,
	key: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
	/** Seconds into raw.mp4. */
	t: Schema.optionalKey(Schema.Finite),
}) {}

/**
 * What the hosted viewer stores per report: one or more run sections (a single
 * run, or before/after) plus the media paths uploaded next to it.
 */
export class ReportSection extends Schema.Class<ReportSection>("@witness/ReportSection")({
	/** WebVTT captions for `video` (hosted-layout renders; the PR layout burns them in). */
	captions: Schema.optionalKey(Schema.String),
	gif: Schema.optionalKey(Schema.String),
	label: Schema.optionalKey(Schema.String),
	/** Per criterion: [start, end] seconds in the polished video (where its check is shown). */
	seek: Schema.Record(Schema.String, Schema.Tuple([Schema.Finite, Schema.Finite])).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({}))
	),
	sha: Schema.String,
	stills: Schema.Array(ReportStill),
	verdict: Verdict,
	/** Uploaded media paths, relative to the report. */
	video: Schema.optionalKey(Schema.String),
}) {}

export class ReportManifest extends Schema.Class<ReportManifest>("@witness/ReportManifest")({
	createdAt: Schema.String,
	intro: Schema.String,
	notes: Schema.Array(Schema.String),
	pr: Schema.optionalKey(Schema.String),
	preview: Schema.String,
	repo: Schema.optionalKey(Schema.String),
	/** The first section is the one that counts ("after" in a before/after). */
	sections: Schema.NonEmptyArray(ReportSection),
	title: Schema.String,
}) {
	get overall(): CriterionStatus {
		return this.sections[0].verdict.overall
	}
}
