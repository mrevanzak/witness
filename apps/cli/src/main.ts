#!/usr/bin/env node
// witness: independent, recorded QA for code changes.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ComputerProvider, DockerComputerProvider } from "@witness/computer"
import { EXIT_ERROR, EXIT_USAGE, loadRunPair, pairRuns, pairSides } from "@witness/domain"
import {
	exitCodeOfResult,
	Git,
	modelFor,
	type RunOutcome,
	runLayer,
	type SpecOptions,
	type VerifyMode,
	type VerifyOutcome,
	verify,
} from "@witness/orchestrator"
import { type Layout, renderRun } from "@witness/renderer"
import { Config, Console, Effect, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { buildImage } from "./image.ts"
import { init } from "./init.ts"
import { startLive } from "./live.ts"
import { publish } from "./publish.ts"
import { noReportOptions, writeReport } from "./report.ts"
import { runsDirFlag, runsDirFor } from "./runs.ts"
import { act, DAEMON_ENV, launchSession, sessionHost } from "./session.ts"
import { ACTIONS } from "./session-actions.ts"
import { upload } from "./upload.ts"
import { printVerdict } from "./verdict-text.ts"

/** The CLI was used wrongly (missing task, flags that don't go together). */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

const setExit = (code: number) =>
	Effect.sync(() => {
		process.exitCode = code
	})

/** What `witness run` checks: one mode, with only the settings that mode uses. */
type RunMode =
	| { readonly _tag: "Agent"; readonly task: string }
	| { readonly _tag: "Session"; readonly task: string; readonly idleMs: number }
	| { readonly _tag: "Spec"; readonly task: string; readonly file: string; readonly options: SpecOptions }
	| { readonly _tag: "BootOnly" }

const runFlags = {
	base: Flag.String("base").pipe(
		Flag.withDescription("Diff base (default: merge-base with the default branch)"),
		Flag.optional
	),
	bootOnly: Flag.Boolean("boot-only").pipe(
		Flag.withDescription("Boot the app, take a screenshot, stop"),
		Flag.withDefault(false)
	),
	config: Flag.String("config").pipe(
		Flag.withDescription("witness.yaml outside the repo (may stage host files and secret env)"),
		Flag.optional
	),
	cpus: Flag.Int("cpus").pipe(Flag.withDefault(2)),
	keep: Flag.Boolean("keep").pipe(
		Flag.withDescription("Keep the computer running afterwards"),
		Flag.withDefault(false)
	),
	live: Flag.Boolean("live").pipe(
		Flag.withDescription(
			"Stream the desktop, criteria and steps to a local page while the run goes (on by default; --no-live turns it off)"
		),
		Flag.withDefault(true)
	),
	memoryGb: Flag.Int("memory-gb").pipe(Flag.withDefault(4)),
	parallel: Flag.Boolean("parallel").pipe(
		Flag.withDescription(
			"Walkthrough and independent modes: verify the base commit and the change at the same time, in two computers (twice the --memory-gb and --cpus at once; the live view shows the change)"
		),
		Flag.withDefault(false)
	),
	ref: Flag.String("ref").pipe(Flag.withDescription("Commit, branch or tag to verify"), Flag.withDefault("HEAD")),
	repo: Flag.String("repo").pipe(Flag.withDescription("App directory inside a git repo"), Flag.withDefault(".")),
	runsDir: runsDirFlag,
	session: Flag.Boolean("session").pipe(
		Flag.withDescription(
			"Session mode: boot, record, and wait for `witness act` commands from the caller (a Claude Code session drives the QA)"
		),
		Flag.withDefault(false)
	),
	sessionIdle: Flag.Int("session-idle").pipe(
		Flag.withDescription("Session mode: close a session after this many seconds without a command (default 900)"),
		Flag.optional
	),
	slowMo: Flag.Int("slow-mo").pipe(
		Flag.withDescription(
			"Walkthrough mode: pause after each Playwright action so the video can be followed (ms, default 400)"
		),
		Flag.optional
	),
	specTimeout: Flag.Int("spec-timeout").pipe(
		Flag.withDescription("Walkthrough mode: stop the spec after this many seconds (default 900)"),
		Flag.optional
	),
	states: Flag.Literals("states", ["before-after", "after"]).pipe(
		Flag.withDescription(
			"before-after: also verify the base commit first, so the report shows the app before and after the change. after: the change only. Default: witness.yaml `states`, else before-after"
		),
		Flag.optional
	),
	task: Flag.String("task").pipe(Flag.withDescription("What the change is supposed to do"), Flag.optional),
	taskFile: Flag.FileText("task-file").pipe(Flag.withDescription("Read the task from a file"), Flag.optional),
	vnc: Flag.Boolean("vnc").pipe(Flag.withDescription("Expose the computer's noVNC endpoint"), Flag.withDefault(false)),
	walkthrough: Flag.String("walkthrough").pipe(
		Flag.withDescription(
			"Walkthrough mode: a Playwright spec drives the app (one of the app's own, run at the exact commit, or a file outside the repo)"
		),
		Flag.optional
	),
}
type RunFlags = Command.Command.Config.Infer<typeof runFlags>

/** The mode the flags ask for, refusing combinations that cannot mean anything. */
const runModeOf = Effect.fnUntraced(function* (f: RunFlags) {
	const path = yield* Path.Path
	const usage = (message: string) => Effect.fail(new UsageError({ message }))
	const chosen = [
		f.bootOnly && "--boot-only",
		f.session && "--session",
		Option.isSome(f.walkthrough) && "--walkthrough",
	]
	if (chosen.filter(Boolean).length > 1) {
		return yield* usage(`${chosen.filter(Boolean).join(" and ")} are different modes; pick one`)
	}
	const onlyFor = (flag: string, given: boolean, mode: string, ok: boolean) =>
		given && !ok ? usage(`${flag} only applies to ${mode}`) : Effect.void
	yield* onlyFor("--slow-mo", Option.isSome(f.slowMo), "--walkthrough", Option.isSome(f.walkthrough))
	yield* onlyFor("--spec-timeout", Option.isSome(f.specTimeout), "--walkthrough", Option.isSome(f.walkthrough))
	yield* onlyFor("--session-idle", Option.isSome(f.sessionIdle), "--session", f.session)
	if (f.session && (f.keep || f.parallel)) {
		return yield* usage(
			"--session cannot be combined with --keep or --parallel (a session checks the base commit, then the change)"
		)
	}
	if (f.bootOnly) {
		return { _tag: "BootOnly" } satisfies RunMode
	}
	const task = Option.orElse(f.task, () => f.taskFile)
	if (Option.isNone(task)) {
		return yield* usage("--task or --task-file is required (or --boot-only)")
	}
	if (f.session) {
		return {
			_tag: "Session",
			idleMs: Option.getOrElse(f.sessionIdle, () => 900) * 1000,
			task: task.value,
		} satisfies RunMode
	}
	if (Option.isSome(f.walkthrough)) {
		return {
			_tag: "Spec",
			file: path.resolve(f.walkthrough.value),
			options: {
				slowMo: Option.getOrElse(f.slowMo, () => 400),
				timeoutMs: Option.getOrElse(f.specTimeout, () => 900) * 1000,
			},
			task: task.value,
		} satisfies RunMode
	}
	return { _tag: "Agent", task: task.value } satisfies RunMode
})

/** The orchestrator's mode for a run mode that needs no session process. */
const verifyModeOf = (mode: Exclude<RunMode, { _tag: "Session" }>): VerifyMode => {
	switch (mode._tag) {
		case "Agent":
			return { _tag: "Agent", execute: {} }
		case "BootOnly":
			return mode
		case "Spec":
			return { _tag: "Spec", file: mode.file, options: mode.options }
	}
}

/** Opens the live view for whoever started the run (a person or an agent), never in CI. */
const openLive = Effect.fnUntraced(function* () {
	const live = yield* startLive()
	yield* Console.log(`live view: ${live.url}`)
	const noOpen = yield* Config.Boolean("WITNESS_NO_OPEN").pipe(Config.withDefault(false))
	const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false))
	if (!(noOpen || ci)) {
		yield* ChildProcessSpawner.ChildProcessSpawner.use((s) =>
			s.exitCode(ChildProcess.make(process.platform === "darwin" ? "open" : "xdg-open", [live.url]))
		).pipe(Effect.ignore)
	}
	return live
})

const printOutcome = Effect.fnUntraced(function* (o: RunOutcome, heading: string) {
	const r = o.result
	switch (r._tag) {
		case "Booted":
			return yield* Console.log(`BOOTED in ${(r.bootMs / 1000).toFixed(1)} s (boot only, no verdict)`)
		case "Blocked":
			return yield* printVerdict(heading, r.blocked)
		case "Verified":
			return yield* printVerdict(heading, r.verdict)
	}
})

const run = Command.make(
	"run",
	runFlags,
	Effect.fn(function* (f) {
		const path = yield* Path.Path
		const mode = yield* runModeOf(f)
		const runsDir = yield* runsDirFor(f.runsDir)
		const daemonRunId = Option.fromUndefinedOr(process.env[DAEMON_ENV])
		if (mode._tag === "Session" && Option.isNone(daemonRunId)) {
			return yield* setExit(yield* launchSession(runsDir))
		}
		yield* ComputerProvider.use((p) => p.cleanupOrphans).pipe(Effect.ignore)

		// A session's process serves `witness act` for the whole run; `finished` tells waiting clients it's over.
		const prepared =
			mode._tag === "Session"
				? yield* sessionHost(
						path.resolve(
							runsDir,
							Option.getOrElse(daemonRunId, () => "")
						),
						mode.idleMs
					).pipe(
						Effect.map((host) => ({
							finished: host.finished,
							mode: { _tag: "Session", program: host.program } as const,
						}))
					)
				: { finished: Effect.void, mode: verifyModeOf(mode) }
		const verifyMode: VerifyMode = prepared.mode
		const live = f.live ? Option.some(yield* openLive()) : Option.none()
		const outcome: VerifyOutcome = yield* verify({
			base: f.base,
			configPath: f.config,
			cpus: f.cpus,
			enableVnc: f.vnc || f.live,
			keep: f.keep,
			memoryGb: f.memoryGb,
			mode: verifyMode,
			onComputer: (c) => (c.liveView && !f.live ? Console.log(`desktop (noVNC): ${c.liveView}`) : Effect.void),
			parallel: f.parallel,
			ref: f.ref,
			repo: f.repo,
			states: f.states,
			task: mode._tag === "BootOnly" ? "boot only" : mode.task,
		}).pipe(
			Effect.provide(
				runLayer(
					runsDir,
					Option.getOrUndefined(daemonRunId),
					Option.match(live, { onNone: () => undefined, onSome: (l) => l.publish })
				).pipe(Layer.provideMerge(modelFor(verifyMode)))
			)
		)
		yield* prepared.finished

		// The before run is evidence only; the exit code is the change's verdict.
		if (Option.isSome(outcome.before)) {
			yield* printOutcome(outcome.before.value, "before (base commit): ")
			yield* Console.log("")
		}
		yield* printOutcome(outcome, Option.isSome(outcome.before) ? "after (the change): " : "")
		yield* Console.log(`run dir: ${outcome.runDir}`)
		yield* setExit(exitCodeOfResult(outcome.result))
	}, Effect.scoped)
).pipe(Command.withDescription("Verify a change: boot it in a fresh computer, check it, record it, write a verdict"))

/** A pair's videos are labelled before and after (--label renames the after); a single run takes --label as is. */
const headerOf = (label: string, sides: number, flag: Option.Option<string>) => {
	if (sides === 1) {
		return flag
	}
	return label === "after" ? Option.orElse(flag, () => Option.some(label)) : Option.some(label)
}

const render = Command.make(
	"render",
	{
		animation: Flag.Boolean("animation").pipe(
			Flag.withDescription(
				"Zoom on each action, glide the cursor and ripple clicks; --no-animation plays the recording as captured. Default: witness.yaml `animation`, else on"
			),
			Flag.optional
		),
		label: Flag.String("label").pipe(
			Flag.withDescription('Header label, e.g. "after" (a run with a before/ run is labelled before and after)'),
			Flag.optional
		),
		layout: Flag.Literals("layout", ["pr", "hosted"]).pipe(
			Flag.withDescription(
				"pr: criteria rail, captions and verdict card in the video. hosted: the app fills the frame, captions go to captions.vtt. Default: witness.yaml `evidence`, else pr"
			),
			Flag.optional
		),
		runDir: Argument.String("run-dir"),
	},
	Effect.fn(function* (f) {
		const pair = yield* loadRunPair(f.runDir)
		// The witness.yaml the run used says how it renders, unless a flag does.
		const defaults = pair.after.info.render
		const layout = Option.getOrElse(f.layout, (): Layout => defaults?.evidence ?? "pr")
		const animate = Option.getOrElse(f.animation, () => defaults?.animation ?? true)
		const sides = pairSides(pair)
		for (const { label, run: side } of sides) {
			const header = headerOf(label, sides.length, f.label)
			const r = yield* renderRun(side.dir, {
				animate,
				layout,
				...Option.match(header, { onNone: () => ({}), onSome: (l) => ({ label: l }) }),
			})
			yield* Console.log(
				[
					`${r.polished} (${r.durationSec.toFixed(1)} s, ${r.layout} layout${r.animate ? "" : ", no animation"})`,
					r.gif,
					...Option.toArray(r.captions),
				].join("\n")
			)
		}
	})
).pipe(
	Command.withDescription(
		"Render polished.mp4 and preview.gif from a finished run (and from its before/ run, when it recorded one)"
	)
)

const report = Command.make(
	"report",
	{ runDir: Argument.String("run-dir") },
	Effect.fn(function* ({ runDir }) {
		yield* Console.log(yield* writeReport(yield* loadRunPair(runDir), runDir, { ...noReportOptions, bundle: false }))
	})
).pipe(
	Command.withDescription(
		'Write report.md ("## Manual verification") for a finished run; a run with a before/ run gets a before/after report'
	)
)

const compare = Command.make(
	"compare",
	{
		after: Argument.String("after-run"),
		before: Argument.String("before-run"),
		intro: Flag.String("intro").pipe(Flag.optional),
		note: Flag.String("note").pipe(Flag.withDescription("An extra note line"), Flag.optional),
		out: Flag.String("out").pipe(Flag.withDescription("Output folder (self-contained: report.md + media/)")),
		preview: Flag.String("preview").pipe(Flag.optional),
	},
	Effect.fn(function* (f) {
		const pair = yield* pairRuns(f.before, f.after)
		yield* Console.log(
			yield* writeReport(pair, f.out, {
				...noReportOptions,
				bundle: true,
				intro: f.intro,
				notes: Option.toArray(f.note),
				preview: f.preview,
			})
		)
	})
).pipe(Command.withDescription("Write a before/after report bundle from two runs of the same walkthrough"))

const actCmd = Command.make(
	"act",
	{
		action: Argument.Literals("action", ACTIONS),
		args: Argument.String("args").pipe(Argument.variadic()),
		label: Flag.String("label").pipe(Flag.withDescription("Caption for the video, at most 8 words"), Flag.optional),
		run: Flag.String("run").pipe(
			Flag.withDescription("The session's run dir (default: the newest open session)"),
			Flag.optional
		),
		runsDir: runsDirFlag,
	},
	Effect.fn(function* (f) {
		yield* setExit(yield* act({ ...f, runsDir: yield* runsDirFor(f.runsDir) }))
	})
).pipe(Command.withDescription("Send one recorded action to a session started with `run --session`"))

const publishCmd = Command.make(
	"publish",
	{
		dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
		egoSpace: Flag.String("ego-space").pipe(
			Flag.withDescription("Ego task space signed in to GitHub (uploads media)"),
			Flag.optional
		),
		mode: Flag.Literals("mode", ["auto", "description", "comment"]).pipe(Flag.withDefault("auto")),
		pr: Flag.String("pr").pipe(Flag.withDescription("PR number")),
		repo: Flag.String("repo").pipe(Flag.withDefault(".")),
		report: Flag.String("report").pipe(Flag.withDescription("report.md to publish")),
	},
	Effect.fn(function* (f) {
		yield* publish(f)
	})
).pipe(Command.withDescription("Put a report on a PR: your PR's description, or a comment on someone else's"))

const uploadCmd = Command.make(
	"upload",
	{
		note: Flag.String("note").pipe(Flag.optional),
		pr: Flag.String("pr").pipe(Flag.withDescription("PR number shown on the page"), Flag.optional),
		preview: Flag.String("preview").pipe(Flag.optional),
		repoName: Flag.String("repo-name").pipe(Flag.optional),
		runs: Argument.String("run-dir").pipe(Argument.variadic({ max: 2, min: 1 })),
		title: Flag.String("title").pipe(Flag.optional),
	},
	Effect.fn(function* (f) {
		// One run (with the before/ it recorded, if any), or two as before/after.
		const [first, second] = f.runs
		const pair = second === undefined ? yield* loadRunPair(first!) : yield* pairRuns(first!, second)
		yield* upload(pair, {
			...noReportOptions,
			notes: Option.toArray(f.note),
			pr: f.pr,
			preview: f.preview,
			repo: f.repoName,
			title: f.title,
		})
	})
).pipe(
	Command.withDescription(
		"Publish a run (or a before/after pair) as an unlisted hosted report; needs WITNESS_REPORTS_URL and WITNESS_UPLOAD_TOKEN"
	)
)

const initCmd = Command.make(
	"init",
	{
		evidence: Flag.Literals("evidence", ["pr", "hosted"]).pipe(
			Flag.withDescription(
				"Where `publish` puts evidence: pr (media in the PR) or hosted (a hosted report linked from the PR). Asked when omitted on a terminal"
			),
			Flag.optional
		),
		force: Flag.Boolean("force").pipe(Flag.withDescription("Overwrite an existing file"), Flag.withDefault(false)),
		out: Flag.String("out").pipe(
			Flag.withDescription("Where to write it (default: <repo>/witness.yaml)"),
			Flag.optional
		),
		repo: Flag.String("repo").pipe(
			Flag.withDescription("The app's repo (or the folder in it that holds the app)"),
			Flag.withDefault(".")
		),
	},
	Effect.fn(function* (f) {
		yield* init(f)
	})
).pipe(
	Command.withDescription(
		"Draft a witness.yaml from the repo's lockfile, scripts, Playwright webServer, docker compose and .env.example, and choose where evidence is published"
	)
)

const cleanup = Command.make(
	"cleanup",
	{},
	Effect.fn(function* () {
		const n = yield* ComputerProvider.use((p) => p.cleanupOrphans)
		yield* Console.log(`removed ${n} orphaned run(s)`)
	})
).pipe(Command.withDescription("Remove computers and networks left by crashed runs"))

const imageCmd = Command.make(
	"image",
	{
		tag: Flag.String("tag").pipe(
			Flag.withDescription("Image tag. Default: WITNESS_COMPUTER_IMAGE, else witness-computer:dev"),
			Flag.optional
		),
	},
	Effect.fn(function* (f) {
		yield* buildImage(Option.getOrUndefined(f.tag))
	})
).pipe(Command.withDescription("Build the computer image runs boot (needs Docker)"))

const witness = Command.make("witness").pipe(
	Command.withDescription("Independent, recorded QA for code changes made by AI agents or humans"),
	Command.withSubcommands([initCmd, imageCmd, run, actCmd, render, report, compare, uploadCmd, publishCmd, cleanup])
)

const Services = Layer.mergeAll(Git.layer, DockerComputerProvider).pipe(
	Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
)

/** Errors that mean the command was used wrongly; anything else stopped it. Neither is a verdict. */
const USAGE = new Set(["UsageError", "InitError", "SessionError"])

witness.pipe(
	Command.run({ version: "0.1.0" }),
	Effect.catch((e) =>
		Console.error("message" in e && typeof e.message === "string" ? e.message : String(e)).pipe(
			Effect.andThen(setExit("_tag" in e && USAGE.has(e._tag) ? EXIT_USAGE : EXIT_ERROR))
		)
	),
	Effect.provide(Services),
	NodeRuntime.runMain
)
