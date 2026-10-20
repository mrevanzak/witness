#!/usr/bin/env node
// witness: independent, recorded QA for code changes.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ComputerProvider, DockerComputerProvider } from "@witness/computer"
import { EXIT_CODES, parseWitnessConfig, RunInfo } from "@witness/domain"
import {
	beforeBlockedNote,
	beforeRun,
	Git,
	Model,
	runLayer,
	type VerifyMode,
	type VerifyOutcome,
	verify,
	writeComparisonReport,
	writeRunReport,
} from "@witness/orchestrator"
import { type Layout, renderRun } from "@witness/renderer"
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { drive } from "./drive.ts"
import { init } from "./init.ts"
import { startLive } from "./live.ts"
import { publish } from "./publish.ts"
import { runsDirFor } from "./runs.ts"
import { ACTIONS, act, DAEMON_ENV, launchSession, sessionProgram } from "./session.ts"
import { upload } from "./upload.ts"

/** The CLI was used wrongly (missing task, bad walkthrough file). */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

const setExit = (code: number) =>
	Effect.sync(() => {
		process.exitCode = code
	})

const run = Command.make(
	"run",
	{
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
			Flag.withDescription("Keep the computer running afterwards (see session.json)"),
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
		runsDir: Flag.String("runs-dir").pipe(
			Flag.withDescription("Where run folders go (default: .witness/runs at the current git root)"),
			Flag.optional
		),
		session: Flag.Boolean("session").pipe(
			Flag.withDescription(
				"Session mode: boot, record, and wait for `witness act` commands from the caller (a Claude Code session drives the QA)"
			),
			Flag.withDefault(false)
		),
		sessionIdle: Flag.Int("session-idle").pipe(
			Flag.withDescription("Close a session after this many seconds without a command"),
			Flag.withDefault(900)
		),
		slowMo: Flag.Int("slow-mo").pipe(
			Flag.withDescription("Walkthrough mode: pause after each Playwright action so the video can be followed (ms)"),
			Flag.withDefault(400)
		),
		specTimeout: Flag.Int("spec-timeout").pipe(
			Flag.withDescription("Walkthrough mode: stop the spec after this many seconds"),
			Flag.withDefault(900)
		),
		states: Flag.Literals("states", ["before-after", "after"]).pipe(
			Flag.withDescription(
				"before-after: also verify the base commit first, so the report shows the app before and after the change. after: the change only. Default: witness.yaml `states`, else before-after"
			),
			Flag.optional
		),
		task: Flag.String("task").pipe(Flag.withDescription("What the change is supposed to do"), Flag.optional),
		taskFile: Flag.FileText("task-file").pipe(Flag.withDescription("Read the task from a file"), Flag.optional),
		vnc: Flag.Boolean("vnc").pipe(
			Flag.withDescription("Expose the computer's noVNC endpoint"),
			Flag.withDefault(false)
		),
		walkthrough: Flag.String("walkthrough").pipe(
			Flag.withDescription(
				"Walkthrough mode: a Playwright spec drives the app (one of the app's own, run at the exact commit, or a file outside the repo)"
			),
			Flag.optional
		),
	},
	Effect.fn(function* (f) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const task = Option.orElse(f.task, () => f.taskFile)
		const bootOnly = f.bootOnly || Option.contains(task, "noop")
		if (Option.isNone(task) && !bootOnly) {
			return yield* new UsageError({ message: "--task or --task-file is required (or --boot-only)" })
		}
		if (f.session && (bootOnly || Option.isSome(f.walkthrough) || f.keep || f.parallel)) {
			return yield* new UsageError({
				message:
					"--session cannot be combined with --boot-only, --walkthrough, --keep or --parallel (a session checks the base commit, then the change)",
			})
		}
		const runsDir = yield* runsDirFor(f.runsDir)
		const daemonRunId = Option.fromUndefinedOr(process.env[DAEMON_ENV])
		if (f.session && Option.isNone(daemonRunId)) {
			return yield* setExit(yield* launchSession(runsDir))
		}
		let mode: VerifyMode = { _tag: "Agent" }
		if (bootOnly) {
			mode = { _tag: "BootOnly" }
		} else if (f.session) {
			mode = { _tag: "Session", program: yield* sessionProgram(f.sessionIdle * 1000) }
		} else if (Option.isSome(f.walkthrough)) {
			mode = {
				_tag: "Spec",
				file: path.resolve(f.walkthrough.value),
				options: { slowMo: f.slowMo, timeoutMs: f.specTimeout * 1000 },
			}
		}
		yield* ComputerProvider.use((p) => p.cleanupOrphans).pipe(Effect.ignore)

		const live = f.live ? Option.some(yield* startLive()) : Option.none()
		if (Option.isSome(live)) {
			yield* Console.log(`live view: ${live.value.url}`)
			// Open the page for whoever started the run (a person or an agent), never in CI.
			const noOpen = yield* Config.Boolean("WITNESS_NO_OPEN").pipe(Config.withDefault(false))
			const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false))
			if (!(noOpen || ci)) {
				yield* ChildProcessSpawner.ChildProcessSpawner.use((s) =>
					s.exitCode(ChildProcess.make(process.platform === "darwin" ? "open" : "xdg-open", [live.value.url]))
				).pipe(Effect.ignore)
			}
		}
		const layers = runLayer(
			runsDir,
			Option.getOrUndefined(daemonRunId),
			Option.match(live, { onNone: () => undefined, onSome: (l) => l.publish })
		)
		const options = {
			base: f.base,
			configPath: f.config,
			context: Option.none<string>(),
			cpus: f.cpus,
			enableVnc: f.vnc || f.live,
			keep: f.keep,
			memoryGb: f.memoryGb,
			mode,
			onComputer: (c: { readonly liveView: string | undefined }) =>
				c.liveView && !f.live ? Console.log(`desktop (noVNC): ${c.liveView}`) : Effect.void,
			parallel: f.parallel,
			ref: f.ref,
			repo: f.repo,
			runsDir,
			states: f.states,
			task: Option.getOrElse(task, () => "noop"),
		}
		const outcome: VerifyOutcome = yield* verify(options).pipe(
			Effect.provide(layers.agent.pipe(Layer.provideMerge(mode._tag === "Agent" ? Model.claude : Model.unavailable)))
		)

		const summarize = Effect.fnUntraced(function* (o: VerifyOutcome, heading: string) {
			if (Option.isSome(o.blocked)) {
				yield* Console.log(`${heading}BLOCKED (${o.blocked.value.reason}): ${o.blocked.value.message}`)
				if (o.blocked.value.logTail) {
					yield* Console.log(`--- log tail ---\n${o.blocked.value.logTail}`)
				}
			} else if (Option.isSome(o.bootMs)) {
				yield* Console.log(`BOOTED in ${(o.bootMs.value / 1000).toFixed(1)} s (boot only, no verdict)`)
			}
			if (Option.isSome(o.verdict)) {
				const v = o.verdict.value
				yield* Console.log(`\n${heading}${v.overall.toUpperCase()}`)
				for (const c of v.criteria) {
					yield* Console.log(
						`  ${c.id} ${c.status.padEnd(7)} ${c.description}${Option.match(c.video_ts, { onNone: () => "", onSome: ([a, b]) => `  [${a}s-${b}s]` })}`
					)
				}
				if (v.usage.usd > 0) {
					yield* Console.log(`  model spend ≈ $${v.usage.usd.toFixed(2)}`)
				}
			}
		})
		// The before run is evidence only; the exit code is the change's verdict.
		if (outcome.before) {
			yield* summarize(outcome.before, "before (base commit): ")
			yield* Console.log("")
		}
		yield* summarize(outcome, outcome.before ? "after (the change): " : "")
		yield* Console.log(`run dir: ${outcome.runDir}`)
		if (yield* fs.exists(path.join(outcome.runDir, "session.json"))) {
			yield* Console.log(`session: ${path.join(outcome.runDir, "session.json")}`)
		}
		yield* setExit(Option.isSome(outcome.bootMs) ? 0 : EXIT_CODES[outcome.overall])
	}, Effect.scoped)
).pipe(Command.withDescription("Verify a change: boot it in a fresh computer, check it, record it, write a verdict"))

/** The run repo's `evidence` setting (its working-tree witness.yaml), else pr. */
const layoutForRun = Effect.fnUntraced(function* (runDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const evidence = yield* fs.readFileString(path.join(runDir, "run.json")).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunInfo))),
		Effect.flatMap((info) => fs.readFileString(path.join(info.repo, info.prefix, "witness.yaml"))),
		Effect.flatMap(parseWitnessConfig),
		Effect.map((c) => c.evidence),
		Effect.orElseSucceed(() => Option.none<Layout>())
	)
	return Option.getOrElse(evidence, (): Layout => "pr")
})

const render = Command.make(
	"render",
	{
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
	Effect.fn(function* ({ runDir, label, layout }) {
		const chosen = Option.isSome(layout) ? layout.value : yield* layoutForRun(runDir)
		const one = Effect.fnUntraced(function* (dir: string, header: Option.Option<string>) {
			const r = yield* renderRun(dir, {
				layout: chosen,
				...Option.match(header, { onNone: () => ({}), onSome: (l) => ({ label: l }) }),
			})
			yield* Console.log(
				[
					`${r.polished} (${r.durationSec.toFixed(1)} s, ${r.layout} layout)`,
					r.gif,
					...Option.toArray(r.captions),
				].join("\n")
			)
		})
		const before = yield* beforeRun(runDir)
		if (Option.isSome(before) && Option.isNone(before.value.blocked)) {
			yield* one(before.value.dir, Option.some("before"))
			yield* one(
				runDir,
				Option.orElse(label, () => Option.some("after"))
			)
		} else {
			yield* one(runDir, label)
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
		yield* Console.log(yield* writeRunReport(runDir))
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
		yield* Console.log(
			yield* writeComparisonReport({
				after: f.after,
				before: f.before,
				intro: f.intro,
				notes: Option.toArray(f.note),
				outDir: f.out,
				preview: f.preview,
			})
		)
	})
).pipe(Command.withDescription("Write a before/after report bundle from two runs of the same walkthrough"))

const driveCmd = Command.make(
	"drive",
	{
		action: Argument.Literals("action", [
			"shot",
			"snapshot",
			"click",
			"click-text",
			"type",
			"key",
			"scroll",
			"navigate",
			"console",
			"network",
			"logs",
			"eval",
		]),
		args: Argument.String("args").pipe(Argument.variadic()),
		runDir: Argument.String("run-dir"),
	},
	Effect.fn(function* (f) {
		yield* drive(f.runDir, f.action, f.args)
	})
).pipe(Command.withDescription("Hand-drive a kept computer (run --keep) while exploring an app"))

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
		runsDir: Flag.String("runs-dir").pipe(
			Flag.withDescription("Where run folders are (default: .witness/runs at the current git root)"),
			Flag.optional
		),
	},
	Effect.fn(function* (f) {
		yield* setExit(
			yield* act({ ...f, runsDir: yield* runsDirFor(f.runsDir) }).pipe(
				Effect.catchTag("SessionError", (e) => Console.error(e.message).pipe(Effect.as(3)))
			)
		)
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
		// One run, or two as before/after (the second counts). A run that recorded its
		// base commit (states: before-after) brings its own before.
		const before = f.runs.length === 1 ? yield* beforeRun(f.runs[0]!) : Option.none()
		const paired = Option.filter(before, (b) => Option.isNone(b.blocked))
		const runs =
			f.runs.length === 2
				? [
						{ dir: f.runs[0]!, label: "before" },
						{ dir: f.runs[1]!, label: "after" },
					]
				: Option.match(paired, {
						onNone: () => [{ dir: f.runs[0]!, label: "run" }],
						onSome: (b) => [
							{ dir: b.dir, label: "before" },
							{ dir: f.runs[0]!, label: "after" },
						],
					})
		const blockedNote = Option.flatMap(before, (b) => Option.map(b.blocked, beforeBlockedNote))
		yield* upload({
			notes: [...Option.toArray(blockedNote), ...Option.toArray(f.note)],
			pr: f.pr,
			preview: f.preview,
			repo: f.repoName,
			runs,
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
		yield* init(f).pipe(Effect.catchTag("InitError", (e) => Console.error(e.message).pipe(Effect.andThen(setExit(3)))))
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

const witness = Command.make("witness").pipe(
	Command.withDescription("Independent, recorded QA for code changes made by AI agents or humans"),
	Command.withSubcommands([initCmd, run, actCmd, render, report, compare, uploadCmd, driveCmd, publishCmd, cleanup])
)

const Services = Layer.mergeAll(Git.layer, DockerComputerProvider).pipe(
	Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
)

witness.pipe(
	Command.run({ version: "0.1.0" }),
	Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.andThen(setExit(3)))),
	Effect.provide(Services),
	NodeRuntime.runMain
)
