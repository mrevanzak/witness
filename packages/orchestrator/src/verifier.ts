// The verification pipeline: resolve the change, start a fresh computer in a scope,
// boot the app, then run the agent (plan -> execute -> review) or a walkthrough,
// and write verdict.json. The computer is torn down when the scope closes, whatever
// happens.
import { ComputerProvider, type Computer } from "@witness/computer"
import { BlockedVerdict, configSecrets, parseEnvFile, parseWitnessConfig, Plan, RunInfo, type Verdict, Verdict as VerdictSchema, WalkthroughReport, type WitnessConfig } from "@witness/domain"
import { Clock, Effect, FileSystem, Layer, Option, Path } from "effect"
import { AppBooter } from "./app-booter.ts"
import type { Change } from "./change.ts"
import { CurrentRun, type Publish } from "./current-run.ts"
import { Executor, type ExecuteOptions } from "./executor.ts"
import { Git } from "./git.ts"
import { Model } from "./model.ts"
import { Planner } from "./planner.ts"
import { buildVerdict, Reviewer, testerReview } from "./reviewer.ts"
import { Steps } from "./steps.ts"
import { makeTar } from "./tar.ts"
import { runWalkthrough, type WalkthroughProgram } from "./walkthrough.ts"

export type VerifyMode =
	| { readonly _tag: "Agent"; readonly execute?: Partial<ExecuteOptions> }
	| { readonly _tag: "Walkthrough"; readonly program: WalkthroughProgram }
	| { readonly _tag: "BootOnly" }

export interface VerifyOptions {
	readonly repo: string
	readonly ref: string
	readonly base: Option.Option<string>
	readonly task: string
	readonly runsDir: string
	readonly mode: VerifyMode
	/** A witness.yaml outside the repo; its `files` and `secret_env` resolve relative to it. */
	readonly configPath: Option.Option<string>
	/** Extra context for the planner (e.g. PR title/body). */
	readonly context: Option.Option<string>
	readonly keep: boolean
	readonly enableVnc: boolean
	readonly memoryGb: number
	readonly cpus: number
	/** Called once the computer is up (live view, session file). */
	readonly onComputer?: (computer: Computer) => Effect.Effect<void>
}

export interface VerifyOutcome {
	readonly runId: string
	readonly runDir: string
	readonly overall: "pass" | "fail" | "blocked"
	readonly verdict: Option.Option<Verdict>
	/** Set when the run never reached a verdict (bad config, boot failure). */
	readonly blocked: Option.Option<{ readonly reason: string; readonly message: string; readonly logTail: string }>
	/** Set in boot-only mode. */
	readonly bootMs: Option.Option<number>
}

const blockedOutcome = (reason: string, message: string, logTail = "") =>
	Effect.gen(function* () {
		const run = yield* CurrentRun
		yield* run.log("run.blocked", { reason, message })
		yield* run.writeJson("verdict.json", BlockedVerdict, new BlockedVerdict({ overall: "blocked", reason, notes: message, ...(logTail ? { log_tail: logTail } : {}) }))
		return { runId: run.id, runDir: run.dir, overall: "blocked", verdict: Option.none(), blocked: Option.some({ reason, message, logTail }), bootMs: Option.none() } satisfies VerifyOutcome
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
	if (Option.isNone(text)) return { _tag: "Missing" as const }
	const parsed = yield* parseWitnessConfig(text.value).pipe(Effect.result)
	if (parsed._tag === "Failure") return { _tag: "Invalid" as const, message: parsed.failure.message }
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
			fs.readFile(path.resolve(base, src)).pipe(Effect.map((data) => ({ name, data: Buffer.from(data), mode: /\.(sh|mjs)$/.test(name) ? 0o755 : 0o644 })))
		)
		if (files.length) staged = makeTar(files, { uid: 1000, gid: 1000, user: "qa", group: "qa" })
	} else if (Object.keys(config.files).length || Option.isSome(config.secretEnv)) {
		return { _tag: "Invalid" as const, message: "files/secret_env are only allowed in a config passed with --config" }
	}
	return { _tag: "Ok" as const, config, text: text.value, staged }
})

const agentRun = Effect.fnUntraced(function* (computer: Computer, config: WitnessConfig, change: Change, mode: Extract<VerifyMode, { _tag: "Agent" }>) {
	const run = yield* CurrentRun
	const model = yield* Model
	yield* run.log("plan.start", { model: model.id })
	const plan = yield* Planner.use((p) => p.plan(change, config))
	yield* run.writeJson("plan.json", Plan, plan)
	yield* run.log("plan.done", { criteria: plan.criteria.map((c) => ({ id: c.id, kind: c.kind, description: c.description })) })

	// Boot noise is not blamed on the first criterion.
	yield* Effect.all([computer.consoleMessages, computer.networkEvents]).pipe(Effect.ignore)
	yield* computer.startRecording("raw.mkv")
	yield* computer.act({ action: { type: "wait", ms: 700 } })
	const exec = yield* Executor.use((x) => x.execute(computer, plan, config, mode.execute))
	yield* computer.act({ action: { type: "wait", ms: 800 } }).pipe(Effect.ignore)
	const rec = yield* computer.stopRecording
	const t0 = Option.fromNullOr(rec.t0)
	const steps = yield* Steps.use((s) => s.finalize(t0))
	yield* run.log("execute.done", { stopped: exec.stoppedBecause, steps: steps.length, video_s: rec.duration })

	const appLogTail = yield* computer.logs("app.log", 120).pipe(Effect.orElseSucceed(() => ""))
	const review = yield* Reviewer.use((r) => r.review(plan, exec, steps, appLogTail))
	const usage = yield* model.usage
	const verdict = buildVerdict({ plan, exec, review, t0, duration: Option.some(rec.duration), modelId: model.id, usage })
	yield* run.writeJson("usage.json", VerdictSchema.fields.usage, verdict.usage)
	return verdict
})

const walkthroughRun = Effect.fnUntraced(function* (computer: Computer, config: WitnessConfig, change: Change, program: WalkthroughProgram) {
	const run = yield* CurrentRun
	yield* computer.startRecording("raw.mkv")
	yield* computer.act({ action: { type: "wait", ms: 600 } })
	const outcome = yield* runWalkthrough(computer, config, change, program)
	yield* computer.act({ action: { type: "wait", ms: 800 } }).pipe(Effect.ignore)
	const rec = yield* computer.stopRecording
	const t0 = Option.fromNullOr(rec.t0)
	yield* Steps.use((s) => s.finalize(t0))
	const report = new WalkthroughReport({
		...outcome.report,
		stills: outcome.report.stills.map((s) => (Option.isSome(t0) ? { ...s, t: Math.round((s.at - t0.value) / 100) / 10 } : s)),
	})
	yield* run.writeJson("plan.json", Plan, outcome.plan)
	yield* run.writeJson("walkthrough.json", WalkthroughReport, report)
	const usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }
	return buildVerdict({ plan: outcome.plan, exec: outcome.exec, review: testerReview(outcome.exec, report.notes.join("\n")), t0, duration: Option.some(rec.duration), modelId: "in-session", usage })
})

/** Runs one verification. Requires Git, ComputerProvider, FileSystem/Path, and Model in agent mode. */
export const verify = Effect.fn("verify")(function* (opts: VerifyOptions) {
	const git = yield* Git
	const provider = yield* ComputerProvider
	const run = yield* CurrentRun

	const repo = yield* git.resolve(opts.repo, opts.ref, opts.base)
	yield* run.log("run.start", { repo: repo.root, prefix: repo.prefix, sha: repo.sha, base: Option.getOrNull(repo.baseSha), mode: opts.mode._tag, runDir: run.dir })
	yield* run.writeJson(
		"run.json",
		RunInfo,
		new RunInfo({ id: run.id, repo: repo.root, prefix: repo.prefix, ref: opts.ref, sha: repo.sha, base: Option.getOrNull(repo.baseSha), task: opts.task, startedAt: new Date(yield* Clock.currentTimeMillis).toISOString() })
	)

	const partial = {
		repo,
		task: opts.task,
		diff: yield* git.diff(repo),
		files: yield* git.changedFiles(repo),
		readme: Option.orElse(yield* git.showFile(repo, "README.md"), () => Option.none<string>()),
		context: opts.context,
	}
	const loaded = yield* loadConfig(opts, partial)
	if (loaded._tag === "Missing") return yield* blockedOutcome("no_witness_yaml", `no witness.yaml at ${repo.prefix || "the repo root"} in ${repo.sha.slice(0, 7)}`)
	if (loaded._tag === "Invalid") return yield* blockedOutcome("invalid_witness_yaml", loaded.message)
	const { config, staged } = loaded
	const change: Change = { ...partial, configText: loaded.text }
	yield* run.writeText("change.diff", change.diff)
	const source = yield* git.archive(repo)
	yield* run.log("source", { bytes: source.length })

	return yield* Effect.scoped(
		Effect.gen(function* () {
			const computer = yield* provider.create({ runId: run.id, artifactsDir: run.computerDir, enableVnc: opts.enableVnc, memoryGb: opts.memoryGb, cpus: opts.cpus, keep: opts.keep })
			yield* run.log("computer.created", { id: computer.id.slice(0, 12), network: computer.network, liveView: computer.liveView })
			if (opts.onComputer) yield* opts.onComputer(computer)

			const boot = yield* AppBooter.use((b) => b.boot(computer, config, source, staged)).pipe(Effect.result)
			if (boot._tag === "Failure") return yield* blockedOutcome("app_failed_to_boot", `${boot.failure.stage}: ${boot.failure.message}`, boot.failure.logTail)

			const done = (verdict: Verdict) =>
				Effect.gen(function* () {
					yield* run.writeJson("verdict.json", VerdictSchema, verdict)
					yield* run.log("verdict", { overall: verdict.overall, criteria: verdict.criteria.map((c) => `${c.id}=${c.status}`), usd: verdict.usage.usd })
					return { runId: run.id, runDir: run.dir, overall: verdict.overall, verdict: Option.some(verdict), blocked: Option.none(), bootMs: Option.none() } satisfies VerifyOutcome
				})

			switch (opts.mode._tag) {
				case "BootOnly": {
					yield* computer.act({ action: { type: "wait", ms: 1500 } })
					yield* run.writeBytes("booted.png", (yield* computer.screenshot()).data)
					return { runId: run.id, runDir: run.dir, overall: "blocked", verdict: Option.none(), blocked: Option.none(), bootMs: Option.some(boot.success) } satisfies VerifyOutcome
				}
				case "Walkthrough":
					return yield* done(yield* walkthroughRun(computer, config, change, opts.mode.program))
				case "Agent":
					return yield* done(yield* agentRun(computer, config, change, opts.mode))
			}
		})
	)
})

/** Per-run services (CurrentRun first, then what depends on it). Model is needed for agent mode. */
export const runLayer = (runsDir: string, id?: string, publish?: Publish) => {
	const base = Layer.mergeAll(Steps.layer, AppBooter.layer).pipe(Layer.provideMerge(CurrentRun.layer(runsDir, id, publish)))
	return {
		base,
		agent: Layer.mergeAll(Planner.layer, Executor.layer, Reviewer.layer).pipe(Layer.provideMerge(base)),
	}
}
