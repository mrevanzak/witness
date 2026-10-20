// The verification pipeline: resolve the change, start a fresh computer in a scope,
// boot the app, record the mode (the agent: plan -> execute -> review; a session
// driven command by command; or a Playwright spec), and write verdict.json. The
// computer is torn down when the scope closes, whatever happens.
//
// With `states: before-after` the base commit is verified first, the same way and
// against the same criteria, in its own run under `<runDir>/before/`, so the report
// can show the app before and after the change. The change's run is the one that
// counts. Anything that stops a side before its verdict leaves a blocked verdict.
import { type Computer, ComputerProvider } from "@witness/computer"
import {
	type AgentPlan,
	BEFORE_DIR,
	BlockedVerdict,
	type Criterion,
	configSecrets,
	type EvidenceStates,
	EXIT_CODES,
	messageOf,
	Plan,
	parseEnvFile,
	parseWitnessConfig,
	RenderDefaults,
	RUN_FILES,
	RunInfo,
	secretEnvValues,
	Verdict,
	WalkthroughReport,
	type WitnessConfig,
} from "@witness/domain"
import { Clock, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { bootApp } from "./app-booter.ts"
import type { Change } from "./change.ts"
import { qaTar } from "./container.ts"
import { buildVerdict, type ModeRun, noUsage, planOf, type ReviewOutput, testerReview } from "./criteria.ts"
import { CurrentRun, type Publish } from "./current-run.ts"
import { type ExecuteOptions, execute } from "./executor.ts"
import { Git, type RepoRef } from "./git.ts"
import { Model } from "./model.ts"
import { planChange } from "./planner.ts"
import { runPlaywrightSpec, type SpecOptions, type SpecSource } from "./playwright-spec.ts"
import { review } from "./reviewer.ts"
import { runSession, type SessionProgram } from "./session.ts"
import { relSeconds, Steps } from "./steps.ts"

export type VerifyMode =
	| { readonly _tag: "Agent"; readonly execute: Partial<ExecuteOptions> }
	/** A program fed command by command (`run --session`). */
	| { readonly _tag: "Session"; readonly program: SessionProgram }
	/** A Playwright spec: a path inside the app (run at the exact commit) or a file outside the repo. */
	| { readonly _tag: "Spec"; readonly file: string; readonly options: SpecOptions }
	| { readonly _tag: "BootOnly" }

export type VerifyOptions = {
	readonly base: Option.Option<string>
	/** A witness.yaml outside the repo; its `files` and `secret_env` resolve relative to it. */
	readonly configPath: Option.Option<string>
	readonly cpus: number
	readonly enableVnc: boolean
	readonly keep: boolean
	readonly memoryGb: number
	readonly mode: VerifyMode
	/** Verify the base commit and the change at the same time (agent and spec modes; sessions stay in order). */
	readonly parallel: boolean
	/** Called once the computer is up (live view). */
	readonly onComputer?: (computer: Computer) => Effect.Effect<void>
	readonly ref: string
	readonly repo: string
	/** Overrides witness.yaml `states` for this run. */
	readonly states: Option.Option<EvidenceStates>
	readonly task: string
}

/** How one side's run ended. */
export type RunResult =
	| { readonly _tag: "Verified"; readonly verdict: Verdict; readonly plan: Plan }
	/** It never reached a verdict (bad config, boot failure, a mode that could not run). */
	| { readonly _tag: "Blocked"; readonly blocked: BlockedVerdict }
	/** Boot-only mode: the app came up in `bootMs`. */
	| { readonly _tag: "Booted"; readonly bootMs: number }

export type RunOutcome = { readonly runDir: string; readonly runId: string; readonly result: RunResult }

/** The change's run, with the base commit's when it recorded one. */
export type VerifyOutcome = RunOutcome & { readonly before: Option.Option<RunOutcome> }

/** The exit code a run's result stands for. */
export const exitCodeOfResult = (r: RunResult): number => {
	switch (r._tag) {
		case "Booted":
			return 0
		case "Blocked":
			return EXIT_CODES.blocked
		case "Verified":
			return EXIT_CODES[r.verdict.overall]
	}
}

/** The Model a mode needs: Claude for the agent, none otherwise. */
export const modelFor = (mode: VerifyMode) => (mode._tag === "Agent" ? Model.claude : Model.unavailable)

/** No witness.yaml for the commit, or one Witness cannot use. */
class ConfigUnusable extends Schema.TaggedError<ConfigUnusable>()("ConfigUnusable", {
	message: Schema.String,
	reason: Schema.Literals(["no_witness_yaml", "invalid_witness_yaml"]),
}) {}

const outcome = (result: RunResult) =>
	CurrentRun.use((run) => Effect.succeed({ result, runDir: run.dir, runId: run.id } satisfies RunOutcome))

const blockedOutcome = (reason: string, message: string, logTail = "") =>
	Effect.gen(function* () {
		const run = yield* CurrentRun
		yield* run.log("run.blocked", { message, reason })
		const blocked = new BlockedVerdict({
			notes: message,
			overall: "blocked",
			reason,
			...(logTail ? { log_tail: logTail } : {}),
		})
		yield* run.writeJson(RUN_FILES.verdict, BlockedVerdict, blocked)
		return yield* outcome({ _tag: "Blocked", blocked })
	})

/** witness.yaml (repo or verifier-side), with verifier-side staged files and secret env. */
const loadConfig = Effect.fnUntraced(function* (configPath: Option.Option<string>, repo: RepoRef) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const run = yield* CurrentRun
	const invalid = (e: { readonly message: string }) =>
		new ConfigUnusable({ message: e.message, reason: "invalid_witness_yaml" })
	const text = yield* Option.match(configPath, {
		onNone: () => Git.use((git) => git.showFile(repo, "witness.yaml")),
		onSome: (p) => fs.readFileString(p).pipe(Effect.map(Option.some)),
	}).pipe(Effect.mapError(invalid))
	if (Option.isNone(text)) {
		return yield* new ConfigUnusable({
			message: `no witness.yaml at ${repo.prefix || "the repo root"} in ${repo.sha.slice(0, 7)}; draft one with \`witness init\` and pass it with --config`,
			reason: "no_witness_yaml",
		})
	}
	const parsed = yield* parseWitnessConfig(text.value).pipe(Effect.mapError(invalid))
	yield* run.addSecrets(configSecrets(parsed))

	// Host files and secret env only from a verifier-side config, never from the repo under test.
	if (Option.isNone(configPath)) {
		if (Object.keys(parsed.files).length || Option.isSome(parsed.secretEnv)) {
			return yield* invalid({ message: "files/secret_env are only allowed in a config passed with --config" })
		}
		return { config: parsed, staged: Option.none<Uint8Array>(), text: text.value }
	}
	const base = path.dirname(path.resolve(configPath.value))
	const env = yield* Option.match(parsed.secretEnv, {
		onNone: () => Effect.succeed({}),
		onSome: (file) => fs.readFileString(path.resolve(base, file)).pipe(Effect.map(parseEnvFile)),
	}).pipe(Effect.mapError(invalid))
	yield* run.addSecrets(secretEnvValues(env))
	const files = yield* Effect.forEach(Object.entries(parsed.files), ([name, src]) =>
		fs
			.readFile(path.resolve(base, src))
			.pipe(Effect.map((data) => ({ data: Buffer.from(data), mode: /\.(sh|mjs)$/.test(name) ? 0o755 : 0o644, name })))
	).pipe(Effect.mapError(invalid))
	return {
		config: { ...parsed, env: { ...parsed.env, ...env } } satisfies WitnessConfig,
		staged: files.length ? Option.some<Uint8Array>(qaTar(files)) : Option.none<Uint8Array>(),
		text: text.value,
	}
})

/** Which spec to run: the archived copy when the file is part of the app at this commit, else the file itself. */
const specSource = Effect.fnUntraced(function* (file: string, repo: RepoRef) {
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

/** Writes run.json: what is verified, and how its evidence renders when witness.yaml said. */
const writeRunInfo = Effect.fnUntraced(function* (
	task: string,
	repo: RepoRef,
	ref: string,
	config: Option.Option<WitnessConfig>
) {
	const run = yield* CurrentRun
	yield* run.writeJson(
		RUN_FILES.info,
		RunInfo,
		new RunInfo({
			base: Option.getOrNull(repo.baseSha),
			id: run.id,
			prefix: repo.prefix,
			ref,
			repo: repo.root,
			sha: repo.sha,
			startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
			task,
			...Option.match(config, {
				onNone: () => ({}),
				onSome: (c) => ({
					render: new RenderDefaults({ animation: c.animation, evidence: Option.getOrNull(c.evidence) }),
				}),
			}),
		})
	)
})

/** A side's mode, with what it needs for this commit. */
type Prepared =
	| { readonly _tag: "Agent"; readonly plan: AgentPlan; readonly execute: Partial<ExecuteOptions> }
	| { readonly _tag: "Session"; readonly program: SessionProgram; readonly carried: readonly Criterion[] }
	| { readonly _tag: "Spec"; readonly file: string; readonly options: SpecOptions }
	| { readonly _tag: "BootOnly" }

/** One commit's run. */
type Side = {
	/** `change.repo.sha` is the commit this side boots. */
	readonly change: Change
	readonly config: WitnessConfig
	readonly staged: Option.Option<Uint8Array>
	readonly keep: boolean
	readonly state: Option.Option<"before" | "after">
	readonly mode: Prepared
}

/** What a recorded mode hands back: its run, its review, and who checked it. */
type Judged = { readonly run: ModeRun; readonly review: ReviewOutput; readonly modelId: string }

/** Records `produce` and finalizes the step log once the recording stops. */
const recorded = <A, E, R>(computer: Computer, produce: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		yield* computer.startRecording
		yield* computer.act({ action: { ms: 700, type: "wait" } })
		const produced = yield* produce.pipe(Effect.tapError(() => computer.stopRecording.pipe(Effect.ignore)))
		yield* computer.act({ action: { ms: 800, type: "wait" } }).pipe(Effect.ignore)
		const rec = yield* computer.stopRecording
		const t0 = Option.fromNullOr(rec.t0)
		const steps = yield* Steps.use((s) => s.finalize(t0))
		yield* CurrentRun.use((run) => run.log("record.done", { steps: steps.length, video_s: rec.duration }))
		return { duration: rec.duration, produced, steps, t0 }
	})

/** Runs the side's mode in the recorded computer and judges it. */
const recordMode = (computer: Computer, side: Side, mode: Exclude<Prepared, { _tag: "BootOnly" }>) =>
	Effect.gen(function* () {
		const sessionSide = (carried: readonly Criterion[]) => ({
			carried,
			sha: side.change.repo.sha.slice(0, 7),
			state: side.state,
		})
		switch (mode._tag) {
			case "Agent": {
				const model = yield* Model
				const r = yield* recorded(computer, execute(computer, mode.plan, side.config, mode.execute))
				const appLogTail = yield* computer.logs("app.log", 120).pipe(Effect.orElseSucceed(() => ""))
				const judged: Judged = {
					modelId: model.id,
					review: yield* review(mode.plan, r.produced.run, r.produced.evidence, r.steps, appLogTail),
					run: r.produced.run,
				}
				return { ...r, judged, summary: mode.plan.summary, usage: yield* model.usage }
			}
			case "Session": {
				const r = yield* recorded(computer, runSession(computer, side.config, mode.program, sessionSide(mode.carried)))
				return {
					...r,
					judged: scripted(r.produced, "in-session"),
					summary: firstLine(side.change.task),
					usage: noUsage,
				}
			}
			case "Spec": {
				const source = yield* specSource(mode.file, side.change.repo)
				const r = yield* recorded(computer, runPlaywrightSpec(computer, side.config, source, mode.options))
				return {
					...r,
					judged: scripted(r.produced, "playwright"),
					summary: firstLine(side.change.task),
					usage: noUsage,
				}
			}
		}
	})

const firstLine = (s: string) => s.split("\n")[0] ?? ""
const scripted = (run: ModeRun, modelId: string): Judged => ({
	modelId,
	review: testerReview(run, Option.match(run.report, { onNone: () => "", onSome: (r) => r.notes.join("\n") })),
	run,
})

/** Boots the side's commit in a fresh computer and records its mode. Never fails short of a write error. */
const runSide = (opts: VerifyOptions, side: Side) =>
	Effect.gen(function* () {
		const run = yield* CurrentRun
		const git = yield* Git
		const provider = yield* ComputerProvider
		if (Option.isSome(side.state)) {
			yield* run.log("state.start", { sha: side.change.repo.sha, state: side.state.value })
		}
		yield* run.writeText("change.diff", side.change.diff)
		const source = yield* git.archive(side.change.repo)
		yield* run.log("source", { bytes: source.length })

		return yield* Effect.scoped(
			Effect.gen(function* () {
				const computer = yield* provider.create({
					artifactsDir: run.computerDir,
					cpus: opts.cpus,
					enableVnc: opts.enableVnc,
					keep: side.keep,
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
				const bootMs = yield* bootApp(computer, side.config, source, side.staged)
				if (side.mode._tag === "BootOnly") {
					yield* computer.act({ action: { ms: 1500, type: "wait" } })
					yield* run.writeBytes("booted.png", (yield* computer.screenshot()).data)
					return yield* outcome({ _tag: "Booted", bootMs })
				}

				const r = yield* recordMode(computer, side, side.mode)
				const plan = planOf(r.judged.run, r.summary)
				const verdict = buildVerdict({
					duration: Option.some(r.duration),
					modelId: r.judged.modelId,
					review: r.judged.review,
					run: r.judged.run,
					t0: r.t0,
					usage: r.usage,
				})
				yield* run.writeJson(RUN_FILES.plan, Plan, plan)
				if (Option.isSome(r.judged.run.report)) {
					const report = r.judged.run.report.value
					yield* run.writeJson(
						RUN_FILES.walkthrough,
						WalkthroughReport,
						new WalkthroughReport({
							...report,
							stills: report.stills.map((s) =>
								Option.match(r.t0, { onNone: () => s, onSome: (t0) => ({ ...s, t: relSeconds(t0, s.at) }) })
							),
						})
					)
				}
				if (r.usage.requests > 0) {
					yield* run.writeJson("usage.json", Verdict.fields.usage, verdict.usage)
				}
				yield* run.writeJson(RUN_FILES.verdict, Verdict, verdict)
				yield* run.log("verdict", {
					criteria: verdict.criteria.map((c) => `${c.id}=${c.status}`),
					overall: verdict.overall,
					usd: verdict.usage.usd,
				})
				return yield* outcome({ _tag: "Verified", plan, verdict })
			})
		)
	}).pipe(
		Effect.catchTags({
			AppBootFailed: (e) => blockedOutcome("app_failed_to_boot", `${e.stage}: ${e.message}`, e.logTail),
			SpecFailed: (e) => blockedOutcome(e.reason, e.message, e.logTail),
		}),
		Effect.catch((e) =>
			e._tag === "RunWriteError" ? Effect.fail(e) : blockedOutcome("run_failed", `the run stopped: ${messageOf(e)}`)
		)
	)

/**
 * What each side runs. Agent mode plans once, from the change, and the base commit
 * checks the same plan; a session's change side starts with the base commit's criteria.
 */
const preparer = Effect.fnUntraced(function* (mode: VerifyMode, change: Change, config: WitnessConfig) {
	switch (mode._tag) {
		case "Agent": {
			const run = yield* CurrentRun
			yield* run.log("plan.start", { model: (yield* Model).id })
			const plan = yield* planChange(change, config)
			yield* run.log("plan.done", {
				criteria: plan.criteria.map((c) => ({ description: c.description, id: c.id, kind: c.kind })),
			})
			return (_carried: readonly Criterion[]): Prepared => ({ _tag: "Agent", execute: mode.execute, plan })
		}
		case "Session":
			return (carried: readonly Criterion[]): Prepared => ({ _tag: "Session", carried, program: mode.program })
		case "Spec":
		case "BootOnly":
			return (_carried: readonly Criterion[]): Prepared => mode
	}
})

/** Per-run services: the run directory and its step log. */
export const runLayer = (runsDir: string, id?: string, publish?: Publish, folder?: string) =>
	Steps.layer.pipe(Layer.provideMerge(CurrentRun.layer(runsDir, id, publish, folder)))

/**
 * The base commit's run, in `<runDir>/before/` with its own run.json, recording and
 * verdict. It never fails the change's run: a write error there is logged in the
 * change's run. `live: false` keeps it out of the live view, which streams one desktop.
 */
const verifyBefore = Effect.fnUntraced(function* (opts: VerifyOptions, side: Side, live: boolean) {
	const run = yield* CurrentRun
	const secrets = yield* run.secrets
	// Fresh: a nested provide would otherwise reuse the change's Steps (built over its CurrentRun).
	const services = Layer.fresh(runLayer(run.dir, `${run.id}-before`, live ? run.publish : undefined, BEFORE_DIR))
	return yield* Effect.gen(function* () {
		yield* (yield* CurrentRun).addSecrets(secrets)
		yield* writeRunInfo(opts.task, side.change.repo, side.change.repo.sha, Option.some(side.config))
		return yield* runSide(opts, side)
	}).pipe(
		Effect.provide(services),
		Effect.map(Option.some),
		Effect.catch((e) => run.log("before.failed", { message: messageOf(e) }).pipe(Effect.as(Option.none<RunOutcome>())))
	)
})

/** Runs one verification. Requires Git, ComputerProvider, FileSystem/Path, the run layer, and a Model (`modelFor`). */
export const verify = Effect.fn("verify")(function* (opts: VerifyOptions) {
	const git = yield* Git
	const run = yield* CurrentRun
	const repo = yield* git.resolve(opts.repo, opts.ref, opts.base)
	yield* run.log("run.start", {
		base: Option.getOrNull(repo.baseSha),
		mode: opts.mode._tag,
		prefix: repo.prefix,
		repo: repo.root,
		runDir: run.dir,
		sha: repo.sha,
	})
	const single = (o: RunOutcome): VerifyOutcome => ({ ...o, before: Option.none() })

	const [diff, files, readme] = yield* Effect.all(
		[git.diff(repo), git.changedFiles(repo), git.showFile(repo, "README.md")],
		{ concurrency: "unbounded" }
	)
	const loaded = yield* loadConfig(opts.configPath, repo).pipe(Effect.result)
	yield* writeRunInfo(
		opts.task,
		repo,
		opts.ref,
		loaded._tag === "Success" ? Option.some(loaded.success.config) : Option.none()
	)
	if (loaded._tag === "Failure") {
		return single(yield* blockedOutcome(loaded.failure.reason, loaded.failure.message))
	}
	const { config, staged } = loaded.success
	const change: Change = { configText: loaded.success.text, diff, files, readme, repo, task: opts.task }

	const prepare = yield* preparer(opts.mode, change, config).pipe(Effect.result)
	if (prepare._tag === "Failure") {
		return single(yield* blockedOutcome("plan_failed", `no test plan: ${prepare.failure.message}`))
	}
	const mode = opts.mode

	// The base commit, with the change's config (the base may predate witness.yaml) and plan.
	const wantBefore = Option.getOrElse(opts.states, () => config.states) === "before-after" && mode._tag !== "BootOnly"
	if (wantBefore && Option.isNone(repo.baseSha)) {
		yield* run.log("before.skipped", { reason: "no base commit to compare with (pass --base)" })
	}
	const baseSha = wantBefore ? repo.baseSha : Option.none<string>()
	const side = (state: Option.Option<"before" | "after">, carried: readonly Criterion[]): Side =>
		Option.match(
			Option.filter(baseSha, () => Option.contains(state, "before")),
			{
				onNone: () => ({ change, config, keep: opts.keep, mode: prepare.success(carried), staged, state }),
				onSome: (sha) => ({
					change: { ...change, repo: { ...repo, baseSha: Option.none(), sha } },
					config,
					keep: false,
					mode: prepare.success(carried),
					staged,
					state,
				}),
			}
		)
	if (Option.isNone(baseSha)) {
		return single(yield* runSide(opts, side(Option.none(), [])))
	}
	const before = (live: boolean) => verifyBefore(opts, side(Option.some("before"), []), live)
	const after = (carried: readonly Criterion[]) => runSide(opts, side(Option.some("after"), carried))

	// Specs and the agent bring their own criteria, so both commits can run at once.
	if (opts.parallel && mode._tag !== "Session") {
		yield* run.log("before.parallel", { sha: baseSha.value })
		const [b, a] = yield* Effect.all([before(false), after([])], { concurrency: 2 })
		return { ...a, before: b }
	}
	// In order, base commit first: a session then checks the criteria declared on it again.
	const b = yield* before(true)
	const declared = Option.match(b, {
		onNone: () => [],
		onSome: (o) => (mode._tag === "Session" && o.result._tag === "Verified" ? o.result.plan.criteria : []),
	})
	return { ...(yield* after(declared)), before: b }
})
