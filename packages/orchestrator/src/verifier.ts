// The verification pipeline: resolve the change, start a fresh computer in a scope,
// boot the app, then run the agent (plan -> execute -> review), a session driven
// command by command, or a Playwright spec, and write verdict.json. The computer is torn down when the scope closes, whatever
// happens.
//
// With `states: before-after` the base commit is verified first, the same way and
// against the same criteria, in its own run under `<runDir>/before/`, so the report
// can show the app before and after the change. The change's run is the one that
// counts; a before run that cannot boot only leaves a blocked verdict behind.
import { type Computer, ComputerProvider } from "@witness/computer"
import {
	BlockedVerdict,
	configSecrets,
	type EvidenceStates,
	Plan,
	parseEnvFile,
	parseWitnessConfig,
	RunInfo,
	type Verdict,
	Verdict as VerdictSchema,
	WalkthroughReport,
	type WitnessConfig,
} from "@witness/domain"
import { Clock, Effect, FileSystem, Layer, Option, Path } from "effect"
import { AppBooter } from "./app-booter.ts"
import type { Change } from "./change.ts"
import { CurrentRun, type Publish } from "./current-run.ts"
import { type ExecuteOptions, Executor } from "./executor.ts"
import { Git, type RepoRef } from "./git.ts"
import { Model } from "./model.ts"
import { Planner } from "./planner.ts"
import { runPlaywrightSpec, type SpecOptions, type SpecSource } from "./playwright-spec.ts"
import { buildVerdict, Reviewer, testerReview } from "./reviewer.ts"
import { Steps } from "./steps.ts"
import { makeTar } from "./tar.ts"
import { runWalkthrough, type WalkthroughOutcome, type WalkthroughProgram } from "./walkthrough.ts"

export type VerifyMode =
	| { readonly _tag: "Agent"; readonly execute?: Partial<ExecuteOptions> }
	/** A program fed command by command (`run --session`). */
	| { readonly _tag: "Session"; readonly program: WalkthroughProgram }
	/** A Playwright spec: a path inside the app (run at the exact commit) or a file outside the repo. */
	| { readonly _tag: "Spec"; readonly file: string; readonly options: SpecOptions }
	| { readonly _tag: "BootOnly" }

export type VerifyOptions = {
	readonly base: Option.Option<string>
	/** A witness.yaml outside the repo; its `files` and `secret_env` resolve relative to it. */
	readonly configPath: Option.Option<string>
	/** Extra context for the planner (e.g. PR title/body). */
	readonly context: Option.Option<string>
	readonly cpus: number
	readonly enableVnc: boolean
	readonly keep: boolean
	readonly memoryGb: number
	readonly mode: VerifyMode
	/** Verify the base commit and the change at the same time (agent and spec modes; sessions stay in order). */
	readonly parallel: boolean
	/** Called once the computer is up (live view, session file). */
	readonly onComputer?: (computer: Computer) => Effect.Effect<void>
	readonly ref: string
	readonly repo: string
	readonly runsDir: string
	/** Overrides witness.yaml `states` for this run. */
	readonly states: Option.Option<EvidenceStates>
	readonly task: string
}

/** The run of the base commit sits inside the change's run, under this name. */
export const BEFORE_DIR = "before"

export type VerifyOutcome = {
	/** The base commit's run, when the run recorded before and after. */
	readonly before?: VerifyOutcome
	/** Set when the run never reached a verdict (bad config, boot failure). */
	readonly blocked: Option.Option<{ readonly reason: string; readonly message: string; readonly logTail: string }>
	/** Set in boot-only mode. */
	readonly bootMs: Option.Option<number>
	readonly overall: "pass" | "fail" | "blocked"
	readonly runDir: string
	readonly runId: string
	readonly verdict: Option.Option<Verdict>
}

const blockedOutcome = (reason: string, message: string, logTail = "") =>
	Effect.gen(function* () {
		const run = yield* CurrentRun
		yield* run.log("run.blocked", { message, reason })
		yield* run.writeJson(
			"verdict.json",
			BlockedVerdict,
			new BlockedVerdict({ notes: message, overall: "blocked", reason, ...(logTail ? { log_tail: logTail } : {}) })
		)
		return {
			blocked: Option.some({ logTail, message, reason }),
			bootMs: Option.none(),
			overall: "blocked",
			runDir: run.dir,
			runId: run.id,
			verdict: Option.none(),
		} satisfies VerifyOutcome
	})

/** Loads witness.yaml (repo or verifier-side), staged files and secret env. */
const loadConfig = Effect.fnUntraced(function* (opts: VerifyOptions, change: Omit<Change, "configText">) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const git = yield* Git
	const run = yield* CurrentRun
	const text = yield* Option.match(opts.configPath, {
		onNone: () => git.showFile(change.repo, "witness.yaml"),
		onSome: (p) => fs.readFileString(p).pipe(Effect.map(Option.some)),
	})
	if (Option.isNone(text)) {
		return { _tag: "Missing" as const }
	}
	const parsed = yield* parseWitnessConfig(text.value).pipe(Effect.result)
	if (parsed._tag === "Failure") {
		return { _tag: "Invalid" as const, message: parsed.failure.message }
	}
	let config: WitnessConfig = parsed.success
	yield* run.addSecrets(configSecrets(config))

	// Host files and secret env only from a verifier-side config, never from the repo under test.
	let staged: Uint8Array | undefined
	if (Option.isSome(opts.configPath)) {
		const base = path.dirname(path.resolve(opts.configPath.value))
		if (Option.isSome(config.secretEnv)) {
			const env = parseEnvFile(yield* fs.readFileString(path.resolve(base, config.secretEnv.value)))
			config = { ...config, env: { ...config.env, ...env } }
			yield* run.addSecrets(Object.values(env).filter((v) => v.length >= 6))
		}
		const files = yield* Effect.forEach(Object.entries(config.files), ([name, src]) =>
			fs
				.readFile(path.resolve(base, src))
				.pipe(Effect.map((data) => ({ data: Buffer.from(data), mode: /\.(sh|mjs)$/.test(name) ? 0o755 : 0o644, name })))
		)
		if (files.length) {
			staged = makeTar(files, { gid: 1000, group: "qa", uid: 1000, user: "qa" })
		}
	} else if (Object.keys(config.files).length || Option.isSome(config.secretEnv)) {
		return { _tag: "Invalid" as const, message: "files/secret_env are only allowed in a config passed with --config" }
	}
	return { _tag: "Ok" as const, config, staged, text: text.value }
})

/** Agent mode plans once from the change; a before run checks the same plan. */
const planChange = Effect.fnUntraced(function* (change: Change, config: WitnessConfig) {
	const run = yield* CurrentRun
	const model = yield* Model
	yield* run.log("plan.start", { model: model.id })
	const plan = yield* Planner.use((p) => p.plan(change, config))
	yield* run.writeJson("plan.json", Plan, plan)
	yield* run.log("plan.done", {
		criteria: plan.criteria.map((c) => ({ description: c.description, id: c.id, kind: c.kind })),
	})
	return plan
})

const agentRun = Effect.fnUntraced(function* (
	computer: Computer,
	config: WitnessConfig,
	plan: Plan,
	mode: Extract<VerifyMode, { _tag: "Agent" }>
) {
	const run = yield* CurrentRun
	const model = yield* Model

	// Boot noise is not blamed on the first criterion.
	yield* Effect.all([computer.consoleMessages, computer.networkEvents]).pipe(Effect.ignore)
	yield* computer.startRecording("raw.mkv")
	yield* computer.act({ action: { ms: 700, type: "wait" } })
	const exec = yield* Executor.use((x) => x.execute(computer, plan, config, mode.execute))
	yield* computer.act({ action: { ms: 800, type: "wait" } }).pipe(Effect.ignore)
	const rec = yield* computer.stopRecording
	const t0 = Option.fromNullOr(rec.t0)
	const steps = yield* Steps.use((s) => s.finalize(t0))
	yield* run.log("execute.done", { steps: steps.length, stopped: exec.stoppedBecause, video_s: rec.duration })

	const appLogTail = yield* computer.logs("app.log", 120).pipe(Effect.orElseSucceed(() => ""))
	const review = yield* Reviewer.use((r) => r.review(plan, exec, steps, appLogTail))
	const usage = yield* model.usage
	const verdict = buildVerdict({
		duration: Option.some(rec.duration),
		exec,
		modelId: model.id,
		plan,
		review,
		t0,
		usage,
	})
	yield* run.writeJson("usage.json", VerdictSchema.fields.usage, verdict.usage)
	return verdict
})

/** Records `produce` (a session or a spec) and builds the verdict from the steps and criteria it reports. */
const scriptedRun = <E, R>(computer: Computer, modelId: string, produce: Effect.Effect<WalkthroughOutcome, E, R>) =>
	Effect.gen(function* () {
		const run = yield* CurrentRun
		yield* computer.startRecording("raw.mkv")
		yield* computer.act({ action: { ms: 600, type: "wait" } })
		const outcome = yield* produce.pipe(Effect.tapError(() => computer.stopRecording.pipe(Effect.ignore)))
		yield* computer.act({ action: { ms: 800, type: "wait" } }).pipe(Effect.ignore)
		const rec = yield* computer.stopRecording
		const t0 = Option.fromNullOr(rec.t0)
		yield* Steps.use((s) => s.finalize(t0))
		const report = new WalkthroughReport({
			...outcome.report,
			stills: outcome.report.stills.map((s) =>
				Option.isSome(t0) ? { ...s, t: Math.round((s.at - t0.value) / 100) / 10 } : s
			),
		})
		yield* run.writeJson("plan.json", Plan, outcome.plan)
		yield* run.writeJson("walkthrough.json", WalkthroughReport, report)
		const usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, requests: 0, usd: 0 }
		return buildVerdict({
			duration: Option.some(rec.duration),
			exec: outcome.exec,
			modelId,
			plan: outcome.plan,
			review: testerReview(outcome.exec, report.notes.join("\n")),
			t0,
			usage,
		})
	})

/** Which spec to run: the archived copy when the file is part of the app at this commit, else the file itself. */
const specSource = Effect.fnUntraced(function* (file: string, repo: Change["repo"]) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const git = yield* Git
	const real = yield* fs.realPath(path.resolve(file))
	const appRoot = yield* fs.realPath(path.join(repo.root, repo.prefix))
	const rel = path.relative(appRoot, real)
	if (!(rel.startsWith("..") || path.isAbsolute(rel)) && Option.isSome(yield* git.showFile(repo, rel))) {
		return { _tag: "Repo", path: rel } satisfies SpecSource
	}
	return { _tag: "File", name: path.basename(real), text: yield* fs.readFileString(real) } satisfies SpecSource
})

/** Logs the start of a run and writes its run.json. */
const startRun = Effect.fnUntraced(function* (opts: VerifyOptions, repo: RepoRef, ref: string) {
	const run = yield* CurrentRun
	yield* run.log("run.start", {
		base: Option.getOrNull(repo.baseSha),
		mode: opts.mode._tag,
		prefix: repo.prefix,
		repo: repo.root,
		runDir: run.dir,
		sha: repo.sha,
	})
	yield* run.writeJson(
		"run.json",
		RunInfo,
		new RunInfo({
			base: Option.getOrNull(repo.baseSha),
			id: run.id,
			prefix: repo.prefix,
			ref,
			repo: repo.root,
			sha: repo.sha,
			startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
			task: opts.task,
		})
	)
})

/** One commit's run, once the change, its config and (agent mode) its plan are known. */
type StateInput = {
	/** The change; `change.repo.sha` is the commit this run boots. */
	readonly change: Change
	readonly config: WitnessConfig
	readonly staged: Uint8Array | undefined
	/** Set in agent mode. */
	readonly plan: Plan | undefined
	/** Session mode: criteria declared in the before run, checked again here. */
	readonly carried: Plan["criteria"]
	/** Which side of a before/after this is (absent for a single run). */
	readonly state: Option.Option<"before" | "after">
	readonly keep: boolean
}

/** Boots `input.change.repo.sha` in a fresh computer and runs the mode against it. */
const runState = Effect.fnUntraced(function* (opts: VerifyOptions, input: StateInput) {
	const git = yield* Git
	const provider = yield* ComputerProvider
	const run = yield* CurrentRun
	const { change, config, staged } = input
	if (Option.isSome(input.state)) {
		yield* run.log("state.start", { sha: change.repo.sha, state: input.state.value })
	}
	let spec: SpecSource | undefined
	if (opts.mode._tag === "Spec") {
		const found = yield* specSource(opts.mode.file, change.repo).pipe(Effect.result)
		if (found._tag === "Failure") {
			return yield* blockedOutcome("spec_missing", `cannot read the spec ${opts.mode.file}: ${found.failure.message}`)
		}
		spec = found.success
	}
	yield* run.writeText("change.diff", change.diff)
	const source = yield* git.archive(change.repo)
	yield* run.log("source", { bytes: source.length })

	return yield* Effect.scoped(
		Effect.gen(function* () {
			const computer = yield* provider.create({
				artifactsDir: run.computerDir,
				cpus: opts.cpus,
				enableVnc: opts.enableVnc,
				keep: input.keep,
				memoryGb: opts.memoryGb,
				runId: run.id,
			})
			yield* run.log("computer.created", {
				id: computer.id.slice(0, 12),
				liveView: computer.liveView,
				network: computer.network,
			})
			if (opts.onComputer) {
				yield* opts.onComputer(computer)
			}

			const boot = yield* AppBooter.use((b) => b.boot(computer, config, source, staged)).pipe(Effect.result)
			if (boot._tag === "Failure") {
				return yield* blockedOutcome(
					"app_failed_to_boot",
					`${boot.failure.stage}: ${boot.failure.message}`,
					boot.failure.logTail
				)
			}

			const done = (verdict: Verdict) =>
				Effect.gen(function* () {
					yield* run.writeJson("verdict.json", VerdictSchema, verdict)
					yield* run.log("verdict", {
						criteria: verdict.criteria.map((c) => `${c.id}=${c.status}`),
						overall: verdict.overall,
						usd: verdict.usage.usd,
					})
					return {
						blocked: Option.none(),
						bootMs: Option.none(),
						overall: verdict.overall,
						runDir: run.dir,
						runId: run.id,
						verdict: Option.some(verdict),
					} satisfies VerifyOutcome
				})

			switch (opts.mode._tag) {
				case "BootOnly": {
					yield* computer.act({ action: { ms: 1500, type: "wait" } })
					yield* run.writeBytes("booted.png", (yield* computer.screenshot()).data)
					return {
						blocked: Option.none(),
						bootMs: Option.some(boot.success),
						overall: "blocked",
						runDir: run.dir,
						runId: run.id,
						verdict: Option.none(),
					} satisfies VerifyOutcome
				}
				case "Session":
					return yield* done(
						yield* scriptedRun(
							computer,
							"in-session",
							runWalkthrough(computer, config, change, opts.mode.program, input.carried)
						)
					)
				case "Spec":
					return yield* scriptedRun(
						computer,
						"playwright",
						runPlaywrightSpec(computer, config, change, spec!, opts.mode.options)
					).pipe(
						Effect.flatMap(done),
						Effect.catchTag("SpecFailed", (e) => blockedOutcome(e.reason, e.message, e.logTail))
					)
				case "Agent":
					yield* run.writeJson("plan.json", Plan, input.plan!)
					return yield* done(yield* agentRun(computer, config, input.plan!, opts.mode))
			}
		})
	)
})

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The base commit's run, in `<runDir>/before/` with its own run.json, recording and
 * verdict. It never fails the change's run: anything that stops it leaves a blocked
 * verdict (or, if even that can't be written, a log line in the change's run).
 * `live: false` keeps it out of the live view, which streams one desktop at a time.
 */
const verifyBefore = Effect.fnUntraced(function* (opts: VerifyOptions, input: StateInput, live: boolean) {
	const run = yield* CurrentRun
	const secrets = yield* run.secrets
	// Fresh: a nested provide would otherwise reuse the change's Steps and AppBooter (built over its CurrentRun).
	const services = Layer.fresh(runLayer(run.dir, `${run.id}-before`, live ? run.publish : undefined, BEFORE_DIR).agent)
	const before = Effect.gen(function* () {
		yield* (yield* CurrentRun).addSecrets(secrets)
		yield* startRun(opts, input.change.repo, input.change.repo.sha)
		return yield* runState(opts, input).pipe(
			Effect.catch((e) => blockedOutcome("before_failed", `the base commit could not be checked: ${messageOf(e)}`))
		)
	}).pipe(Effect.provide(services))
	return yield* before.pipe(
		Effect.map(Option.some),
		Effect.catch((e) => run.log("before.failed", { message: messageOf(e) }).pipe(Effect.as(Option.none())))
	)
})

/** The change's outcome, carrying the base commit's when there was one. */
const withBefore = (after: VerifyOutcome, before: Option.Option<VerifyOutcome>): VerifyOutcome =>
	Option.match(before, { onNone: () => after, onSome: (b) => ({ ...after, before: b }) })

/** Runs one verification. Requires Git, ComputerProvider, FileSystem/Path, and Model in agent mode. */
export const verify = Effect.fn("verify")(function* (opts: VerifyOptions) {
	const git = yield* Git
	const run = yield* CurrentRun

	const repo = yield* git.resolve(opts.repo, opts.ref, opts.base)
	yield* startRun(opts, repo, opts.ref)

	const partial = {
		context: opts.context,
		diff: yield* git.diff(repo),
		files: yield* git.changedFiles(repo),
		readme: Option.orElse(yield* git.showFile(repo, "README.md"), () => Option.none<string>()),
		repo,
		task: opts.task,
	}
	const loaded = yield* loadConfig(opts, partial)
	if (loaded._tag === "Missing") {
		return yield* blockedOutcome(
			"no_witness_yaml",
			`no witness.yaml at ${repo.prefix || "the repo root"} in ${repo.sha.slice(0, 7)}; draft one with \`witness init\` and pass it with --config`
		)
	}
	if (loaded._tag === "Invalid") {
		return yield* blockedOutcome("invalid_witness_yaml", loaded.message)
	}
	const { config, staged } = loaded
	const change: Change = { ...partial, configText: loaded.text }
	const plan = opts.mode._tag === "Agent" ? yield* planChange(change, config) : undefined

	// The base commit, with the change's config (the base may predate witness.yaml) and plan.
	const wantBefore =
		Option.getOrElse(opts.states, () => config.states) === "before-after" && opts.mode._tag !== "BootOnly"
	if (wantBefore && Option.isNone(repo.baseSha)) {
		yield* run.log("before.skipped", { reason: "no base commit to compare with (pass --base)" })
	}
	const baseSha = wantBefore ? repo.baseSha : Option.none<string>()
	const checkBefore = (live: boolean) =>
		Option.match(baseSha, {
			onNone: () => Effect.succeed(Option.none<VerifyOutcome>()),
			onSome: (sha) =>
				verifyBefore(
					opts,
					{
						carried: [],
						change: { ...change, repo: { ...repo, baseSha: Option.none(), sha } },
						config,
						keep: false,
						plan,
						staged,
						state: Option.some("before"),
					},
					live
				),
		})
	const checkAfter = (carried: Plan["criteria"]) =>
		runState(opts, {
			carried,
			change,
			config,
			keep: opts.keep,
			plan,
			staged,
			state: Option.isSome(baseSha) ? Option.some("after") : Option.none(),
		})

	// Specs and the agent bring their own criteria, so both commits can run at once.
	if (opts.parallel && opts.mode._tag !== "Session" && Option.isSome(baseSha)) {
		yield* run.log("before.parallel", { sha: baseSha.value })
		const [before, after] = yield* Effect.all([checkBefore(false), checkAfter([])], { concurrency: 2 })
		return withBefore(after, before)
	}

	// In order, base commit first: a session then checks the criteria declared on it again.
	const before = yield* checkBefore(true)
	const declared =
		opts.mode._tag === "Session"
			? Option.match(
					Option.flatMap(before, (b) => b.verdict),
					{ onNone: () => [], onSome: (v) => v.criteria }
				)
			: []
	const after = yield* checkAfter(
		declared.map((c) => ({ description: c.description, evidence: "", how_to_check: "", id: c.id, kind: c.kind }))
	)
	return withBefore(after, before)
})

/** Per-run services (CurrentRun first, then what depends on it). Model is needed for agent mode. */
export const runLayer = (runsDir: string, id?: string, publish?: Publish, folder?: string) => {
	const base = Layer.mergeAll(Steps.layer, AppBooter.layer).pipe(
		Layer.provideMerge(CurrentRun.layer(runsDir, id, publish, folder))
	)
	return {
		agent: Layer.mergeAll(Planner.layer, Executor.layer, Reviewer.layer).pipe(Layer.provideMerge(base)),
		base,
	}
}
