#!/usr/bin/env node
// witness: independent, recorded QA for code changes.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ComputerProvider, DockerComputerProvider } from "@witness/computer"
import { EXIT_CODES } from "@witness/domain"
import { Git, Model, runLayer, verify, writeComparisonReport, writeReport, type VerifyMode, type WalkthroughProgram } from "@witness/orchestrator"
import { renderRun } from "@witness/renderer"
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { register } from "node:module"
import { pathToFileURL } from "node:url"
import { drive } from "./Drive.ts"
import { startLive } from "./Live.ts"
import { publish } from "./Publish.ts"
import { upload } from "./Upload.ts"

/** The CLI was used wrongly (missing task, bad walkthrough file). */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {}

const setExit = (code: number) => Effect.sync(() => void (process.exitCode = code))

const loadWalkthrough = Effect.fn("loadWalkthrough")(function* (file: string) {
	const path = yield* Path.Path
	// Walkthroughs import `effect` and `@witness/*` from Witness's own copies, wherever they live.
	yield* Effect.sync(() => register(new URL("./walkthrough-hooks.mjs", import.meta.url), { data: { parentURL: import.meta.url } }))
	const mod = yield* Effect.tryPromise({
		try: () => import(pathToFileURL(path.resolve(file)).href) as Promise<{ default?: unknown }>,
		catch: (e) => new UsageError({ message: `cannot load walkthrough ${file}: ${e instanceof Error ? e.message : String(e)}` }),
	})
	if (!Effect.isEffect(mod.default)) return yield* new UsageError({ message: `${file} must default-export an Effect program (see skills/witness/walkthrough-template.ts)` })
	return mod.default as WalkthroughProgram
})

const run = Command.make(
	"run",
	{
		repo: Flag.String("repo").pipe(Flag.withDescription("App directory inside a git repo"), Flag.withDefault(".")),
		ref: Flag.String("ref").pipe(Flag.withDescription("Commit, branch or tag to verify"), Flag.withDefault("HEAD")),
		base: Flag.String("base").pipe(Flag.withDescription("Diff base (default: merge-base with the default branch)"), Flag.optional),
		task: Flag.String("task").pipe(Flag.withDescription("What the change is supposed to do"), Flag.optional),
		taskFile: Flag.FileText("task-file").pipe(Flag.withDescription("Read the task from a file"), Flag.optional),
		config: Flag.String("config").pipe(Flag.withDescription("witness.yaml outside the repo (may stage host files and secret env)"), Flag.optional),
		walkthrough: Flag.String("walkthrough").pipe(Flag.withDescription("In-session mode: an Effect program that drives the app instead of the model"), Flag.optional),
		bootOnly: Flag.Boolean("boot-only").pipe(Flag.withDescription("Boot the app, take a screenshot, stop"), Flag.withDefault(false)),
		keep: Flag.Boolean("keep").pipe(Flag.withDescription("Keep the computer running afterwards (see session.json)"), Flag.withDefault(false)),
		vnc: Flag.Boolean("vnc").pipe(Flag.withDescription("Expose the computer's noVNC endpoint"), Flag.withDefault(false)),
		live: Flag.Boolean("live").pipe(Flag.withDescription("Open a local page that streams the desktop, criteria and steps while the run goes"), Flag.withDefault(false)),
		memoryGb: Flag.Int("memory-gb").pipe(Flag.withDefault(4)),
		cpus: Flag.Int("cpus").pipe(Flag.withDefault(2)),
		runsDir: Flag.String("runs-dir").pipe(Flag.withDefault("runs")),
	},
	Effect.fn(function* (f) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const task = Option.orElse(f.task, () => f.taskFile)
		const bootOnly = f.bootOnly || Option.contains(task, "noop")
		if (Option.isNone(task) && !bootOnly) return yield* new UsageError({ message: "--task or --task-file is required (or --boot-only)" })
		const mode: VerifyMode = bootOnly
			? { _tag: "BootOnly" }
			: Option.isSome(f.walkthrough)
				? { _tag: "Walkthrough", program: yield* loadWalkthrough(f.walkthrough.value) }
				: { _tag: "Agent" }
		const runsDir = path.resolve(f.runsDir)
		yield* ComputerProvider.use((p) => p.cleanupOrphans).pipe(Effect.ignore)

		const live = f.live ? Option.some(yield* startLive()) : Option.none()
		if (Option.isSome(live)) {
			yield* Console.log(`live view: ${live.value.url}`)
			const noOpen = yield* Config.Boolean("WITNESS_NO_OPEN").pipe(Config.withDefault(false))
			if (!noOpen) yield* ChildProcessSpawner.ChildProcessSpawner.use((s) => s.exitCode(ChildProcess.make(process.platform === "darwin" ? "open" : "xdg-open", [live.value.url]))).pipe(Effect.ignore)
		}
		const layers = runLayer(runsDir, undefined, Option.match(live, { onNone: () => undefined, onSome: (l) => l.publish }))
		const options = {
			repo: f.repo,
			ref: f.ref,
			base: f.base,
			task: Option.getOrElse(task, () => "noop"),
			runsDir,
			mode,
			configPath: f.config,
			context: Option.none<string>(),
			keep: f.keep,
			enableVnc: f.vnc || f.live,
			memoryGb: f.memoryGb,
			cpus: f.cpus,
			onComputer: (c: { readonly liveView: string | undefined }) => (c.liveView && !f.live ? Console.log(`desktop (noVNC): ${c.liveView}`) : Effect.void),
		}
		const outcome = yield* verify(options).pipe(Effect.provide(layers.agent.pipe(Layer.provideMerge(mode._tag === "Agent" ? Model.claude : Model.unavailable))))

		if (Option.isSome(outcome.blocked)) {
			yield* Console.log(`BLOCKED (${outcome.blocked.value.reason}): ${outcome.blocked.value.message}`)
			if (outcome.blocked.value.logTail) yield* Console.log(`--- log tail ---\n${outcome.blocked.value.logTail}`)
		} else if (Option.isSome(outcome.bootMs)) {
			yield* Console.log(`BOOTED in ${(outcome.bootMs.value / 1000).toFixed(1)} s (boot only, no verdict)`)
		}
		if (Option.isSome(outcome.verdict)) {
			const v = outcome.verdict.value
			yield* Console.log(`\n${v.overall.toUpperCase()}`)
			for (const c of v.criteria) yield* Console.log(`  ${c.id} ${c.status.padEnd(7)} ${c.description}${Option.match(c.video_ts, { onNone: () => "", onSome: ([a, b]) => `  [${a}s-${b}s]` })}`)
			if (v.usage.usd > 0) yield* Console.log(`  model spend ≈ $${v.usage.usd.toFixed(2)}`)
		}
		yield* Console.log(`run dir: ${outcome.runDir}`)
		if (yield* fs.exists(path.join(outcome.runDir, "session.json"))) yield* Console.log(`session: ${path.join(outcome.runDir, "session.json")}`)
		yield* setExit(Option.isSome(outcome.bootMs) ? 0 : EXIT_CODES[outcome.overall])
	}, Effect.scoped)
).pipe(Command.withDescription("Verify a change: boot it in a fresh computer, check it, record it, write a verdict"))

const render = Command.make(
	"render",
	{
		runDir: Argument.String("run-dir"),
		label: Flag.String("label").pipe(Flag.withDescription('Header label, e.g. "after"'), Flag.optional),
	},
	Effect.fn(function* ({ runDir, label }) {
		const r = yield* renderRun(runDir, Option.match(label, { onNone: () => ({}), onSome: (l) => ({ label: l }) }))
		yield* Console.log(`${r.polished} (${r.durationSec.toFixed(1)} s)\n${r.gif}`)
	})
).pipe(Command.withDescription("Render polished.mp4 and preview.gif from a finished run"))

const report = Command.make(
	"report",
	{ runDir: Argument.String("run-dir") },
	Effect.fn(function* ({ runDir }) {
		yield* Console.log(yield* writeReport(runDir))
	})
).pipe(Command.withDescription('Write report.md ("## Manual verification") for a finished run'))

const compare = Command.make(
	"compare",
	{
		before: Argument.String("before-run"),
		after: Argument.String("after-run"),
		out: Flag.String("out").pipe(Flag.withDescription("Output folder (self-contained: report.md + media/)")),
		preview: Flag.String("preview").pipe(Flag.optional),
		intro: Flag.String("intro").pipe(Flag.optional),
		note: Flag.String("note").pipe(Flag.withDescription("An extra note line"), Flag.optional),
	},
	Effect.fn(function* (f) {
		yield* Console.log(yield* writeComparisonReport({ before: f.before, after: f.after, outDir: f.out, preview: f.preview, intro: f.intro, notes: Option.toArray(f.note) }))
	})
).pipe(Command.withDescription("Write a before/after report bundle from two runs of the same walkthrough"))

const driveCmd = Command.make(
	"drive",
	{
		runDir: Argument.String("run-dir"),
		action: Argument.Literals("action", ["shot", "snapshot", "click", "click-text", "type", "key", "scroll", "navigate", "console", "network", "logs", "eval"]),
		args: Argument.String("args").pipe(Argument.variadic()),
	},
	Effect.fn(function* (f) {
		yield* drive(f.runDir, f.action, f.args)
	})
).pipe(Command.withDescription("Hand-drive a kept computer (run --keep) while exploring an app"))

const publishCmd = Command.make(
	"publish",
	{
		pr: Flag.String("pr").pipe(Flag.withDescription("PR number")),
		report: Flag.String("report").pipe(Flag.withDescription("report.md to publish")),
		repo: Flag.String("repo").pipe(Flag.withDefault(".")),
		mode: Flag.Literals("mode", ["auto", "description", "comment"]).pipe(Flag.withDefault("auto")),
		egoSpace: Flag.String("ego-space").pipe(Flag.withDescription("Ego task space signed in to GitHub (uploads media)"), Flag.optional),
		dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
	},
	Effect.fn(function* (f) {
		yield* publish(f)
	})
).pipe(Command.withDescription("Put a report on a PR: your PR's description, or a comment on someone else's"))

const uploadCmd = Command.make(
	"upload",
	{
		runs: Argument.String("run-dir").pipe(Argument.variadic({ min: 1, max: 2 })),
		title: Flag.String("title").pipe(Flag.optional),
		pr: Flag.String("pr").pipe(Flag.withDescription("PR number shown on the page"), Flag.optional),
		repoName: Flag.String("repo-name").pipe(Flag.optional),
		preview: Flag.String("preview").pipe(Flag.optional),
		note: Flag.String("note").pipe(Flag.optional),
	},
	Effect.fn(function* (f) {
		// One run, or two as before/after (the second counts).
		const runs = f.runs.length === 2 ? [{ dir: f.runs[0]!, label: "before" }, { dir: f.runs[1]!, label: "after" }] : [{ dir: f.runs[0]!, label: "run" }]
		yield* upload({ runs, title: f.title, pr: f.pr, repo: f.repoName, preview: f.preview, notes: Option.toArray(f.note) })
	})
).pipe(Command.withDescription("Publish a run (or a before/after pair) as an unlisted hosted report; needs WITNESS_REPORTS_URL and WITNESS_UPLOAD_TOKEN"))

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
	Command.withSubcommands([run, render, report, compare, uploadCmd, driveCmd, publishCmd, cleanup])
)

const Services = Layer.mergeAll(Git.layer, DockerComputerProvider).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)))

witness.pipe(
	Command.run({ version: "0.1.0" }),
	Effect.catchTag("UsageError", (e) => Console.error(e.message).pipe(Effect.andThen(setExit(3)))),
	Effect.provide(Services),
	NodeRuntime.runMain
)
