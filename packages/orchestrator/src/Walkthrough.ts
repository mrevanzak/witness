// In-session mode: a walkthrough program (written by the Claude Code session that
// explored the app, or by a human) drives the computer instead of the model. It
// produces the same recording, step log, evidence and verdict as the agent.
//
//   export default Effect.gen(function* () {
//     const w = yield* Walkthrough
//     yield* w.criterion("C1", "feature", "...")
//     yield* w.begin("C1")
//     ...
//   })
import type { Computer, PageElement } from "@witness/computer"
import { type CriterionKind, type CriterionStatus, Plan, redact, Still, WalkthroughReport, type WitnessConfig } from "@witness/domain"
import { Clock, Context, Effect, Option, Ref, Schedule, Schema } from "effect"
import type { Change } from "./Change.ts"
import { CurrentRun } from "./CurrentRun.ts"
import type { CriterionResult, ExecuteResult } from "./Executor.ts"
import { Steps } from "./Steps.ts"

/** A walkthrough step could not be carried out (element missing, wait timed out, page call failed). */
export class WalkthroughStepFailed extends Schema.TaggedError<WalkthroughStepFailed>()("WalkthroughStepFailed", {
	message: Schema.String,
}) {}

type W<A> = Effect.Effect<A, WalkthroughStepFailed>

export class Walkthrough extends Context.Service<
	Walkthrough,
	{
		readonly config: WitnessConfig
		readonly change: Change
		/** Declare a criterion (before `begin`). */
		criterion(id: string, kind: CriterionKind, description: string): Effect.Effect<void>
		begin(id: string): W<void>
		end(id: string, status: CriterionStatus, notes: string): W<void>
		click(x: number, y: number, label: string): W<void>
		/** First visible, enabled interactive element whose name matches (polls until timeout). */
		findElement(match: string | RegExp, options?: { readonly tag?: string; readonly timeoutMs?: number }): W<PageElement>
		clickText(match: string | RegExp, label: string, options?: { readonly tag?: string; readonly timeoutMs?: number }): W<PageElement>
		type(text: string, label: string): W<void>
		key(combo: string, label: string): W<void>
		scroll(dy: number, label: string, at?: { readonly x: number; readonly y: number }): W<void>
		navigate(url: string, label: string): W<void>
		wait(ms: number, label?: string): W<void>
		/** Evaluates a JS expression in the visible tab. */
		evaluate<A = unknown>(expression: string): W<A>
		/** Polls `expression` until truthy. */
		waitFor(expression: string, options?: { readonly timeoutMs?: number; readonly intervalMs?: number }): W<void>
		/** Full-res still for the report, with the sentence that says what it proves. Returns its path. */
		still(name: string, caption: string): W<string>
		note(line: string): Effect.Effect<void>
		preview(line: string): Effect.Effect<void>
		intro(line: string): Effect.Effect<void>
	}
>()("witness/orchestrator/Walkthrough") {}

/** A walkthrough program: what a `--walkthrough` file default-exports. */
export type WalkthroughProgram = Effect.Effect<void, unknown, Walkthrough>

export interface WalkthroughOutcome {
	readonly plan: Plan
	readonly exec: ExecuteResult
	readonly report: WalkthroughReport
	readonly error: Option.Option<string>
}

const SMALL = { width: 320, format: "jpeg" as const, quality: 50 }

/** Builds the Walkthrough service over a computer and runs `program` with it. */
export const runWalkthrough = Effect.fn("runWalkthrough")(function* (computer: Computer, config: WitnessConfig, change: Change, program: WalkthroughProgram) {
	const run = yield* CurrentRun
	const steps = yield* Steps
	const secrets = yield* run.secrets
	const failed = (what: string) => (e: { readonly message: string }) => new WalkthroughStepFailed({ message: `${what}: ${e.message}` })

	const declared = yield* Ref.make<ReadonlyArray<Plan["criteria"][number]>>([])
	const results = yield* Ref.make(new Map<string, CriterionResult>())
	const active = yield* Ref.make<Option.Option<string>>(Option.none())
	const report = yield* Ref.make({ preview: "", intro: "", stills: [] as ReadonlyArray<Still>, notes: [] as ReadonlyArray<string> })
	const stillNo = yield* Ref.make(0)

	const sent = yield* Clock.currentTimeMillis
	const first = yield* computer.screenshot({ width: 320, format: "jpeg" }).pipe(Effect.mapError(failed("screenshot")))
	// Computer clock minus host clock, measured at the request's midpoint.
	const offset = first.at - (sent + (yield* Clock.currentTimeMillis)) / 2
	const now = Clock.currentTimeMillis.pipe(Effect.map((t) => t + offset))
	const current = Ref.get(active).pipe(Effect.map(Option.getOrUndefined))
	const crit = (c: string | undefined) => (c ? { criterion: c } : {})

	const drain = Effect.gen(function* () {
		const [c, n] = yield* Effect.all([computer.consoleMessages.pipe(Effect.orElseSucceed(() => [])), computer.networkEvents.pipe(Effect.orElseSucceed(() => []))])
		const id = yield* current
		if (id) yield* Ref.update(results, (m) => { const r = m.get(id)!; return new Map(m).set(id, { ...r, console: [...r.console, ...c], network: [...r.network, ...n] }) })
		return { console: c, network: n }
	})
	const allConsole = yield* Ref.make<ExecuteResult["console"]>([])
	const allNetwork = yield* Ref.make<ExecuteResult["network"]>([])
	const drainAll = drain.pipe(Effect.tap(({ console: c, network: n }) => Effect.all([Ref.update(allConsole, (a) => [...a, ...c]), Ref.update(allNetwork, (a) => [...a, ...n])])))

	const act = (action: Parameters<Computer["act"]>[0]["action"], settle_ms = 100) =>
		computer.act({ action, settle_ms, shot: SMALL }).pipe(
			Effect.mapError(failed(action.type)),
			Effect.map((s) => s.actionAt ?? s.at)
		)
	const step = (tool: string, at: number, extra: Record<string, unknown> = {}) =>
		Effect.gen(function* () {
			yield* steps.add({ at, tool, ...crit(yield* current), ...extra }).pipe(Effect.mapError(failed("step log")))
		})

	const findElement = Effect.fnUntraced(function* (match: string | RegExp, options: { readonly tag?: string; readonly timeoutMs?: number } = {}) {
		const test = (name: string) => (typeof match === "string" ? name.toLowerCase().includes(match.toLowerCase()) : match.test(name))
		const deadline = (yield* Clock.currentTimeMillis) + (options.timeoutMs ?? 15_000)
		for (;;) {
			const snap = yield* computer.pageSnapshot(100).pipe(Effect.mapError(failed("snapshot")))
			const el = snap.elements.find((e) => test(e.name) && (!options.tag || e.tag === options.tag) && !e.disabled)
			if (el) return el
			if ((yield* Clock.currentTimeMillis) > deadline) {
				return yield* new WalkthroughStepFailed({ message: `no element matching ${String(match)} on ${snap.url}; saw: ${snap.elements.map((e) => e.name).filter(Boolean).slice(0, 30).join(" | ")}` })
			}
			yield* Effect.sleep("300 millis")
		}
	})

	const evaluate = <A>(expression: string): W<A> => computer.evaluate(expression).pipe(Effect.mapError(failed("evaluate")), Effect.map((v) => v as A))

	const service = Walkthrough.of({
		config,
		change,
		criterion: (id, kind, description) => Ref.update(declared, (d) => [...d, { id, kind, description, how_to_check: "", evidence: "" }]),
		begin: Effect.fnUntraced(function* (id) {
			const c = (yield* Ref.get(declared)).find((x) => x.id === id)
			if (!c) return yield* new WalkthroughStepFailed({ message: `criterion ${id} not declared` })
			yield* drainAll
			yield* Ref.set(active, Option.some(id))
			const beganAt = yield* now
			yield* Ref.update(results, (m) => new Map(m).set(id, { id, status: "blocked", notes: "", beganAt, endedAt: undefined, screenshot: undefined, evidence: undefined, console: [], network: [], forced: undefined, steps: 0 }))
			yield* step("begin_criterion", beganAt, { label: `${id}: ${c.description}` })
		}),
		end: Effect.fnUntraced(function* (id, status, notes) {
			if (!(yield* Ref.get(results)).has(id)) return yield* new WalkthroughStepFailed({ message: `criterion ${id} was not begun` })
			yield* drainAll
			const full = yield* computer.screenshot().pipe(Effect.mapError(failed("screenshot")))
			const file = `${id.toLowerCase()}-${status}.png`
			yield* run.writeBytes(file, full.data).pipe(Effect.mapError(failed("write")))
			const clean = redact(notes, secrets)
			yield* Ref.update(results, (m) => new Map(m).set(id, { ...m.get(id)!, status, notes: clean, endedAt: full.at, screenshot: file }))
			yield* step("end_criterion", full.at, { status, label: `${id}: ${status.toUpperCase()}`, notes: clean })
			yield* Ref.set(active, Option.none())
		}),
		click: Effect.fnUntraced(function* (x, y, label) {
			yield* step("click", yield* act({ type: "click", x, y }), { label, x, y })
		}),
		findElement,
		clickText: Effect.fnUntraced(function* (match, label, options) {
			const el = yield* findElement(match, options)
			yield* step("click", yield* act({ type: "click", x: el.x, y: el.y }), { label, x: el.x, y: el.y })
			return el
		}),
		type: Effect.fnUntraced(function* (text, label) {
			yield* step("type", yield* act({ type: "type", text }), { label, chars: text.length })
		}),
		key: Effect.fnUntraced(function* (combo, label) {
			yield* step("key", yield* act({ type: "key", combo }), { label, combo })
		}),
		scroll: Effect.fnUntraced(function* (dy, label, at) {
			yield* step("scroll", yield* act({ type: "scroll", dy, ...(at ?? {}) }, 200), { label, ...(at ?? {}) })
		}),
		navigate: Effect.fnUntraced(function* (url, label) {
			const nav = yield* computer.navigate(url, 60_000).pipe(Effect.mapError(failed("navigate")))
			if (nav.error) return yield* new WalkthroughStepFailed({ message: `navigate ${url}: ${nav.error}` })
			yield* step("navigate", nav.at, { label, url })
		}),
		wait: Effect.fnUntraced(function* (ms, label) {
			const at = yield* act({ type: "wait", ms }, 0)
			if (label) yield* step("wait", at, { label })
		}),
		evaluate,
		waitFor: (expression, options = {}) =>
			evaluate<boolean>(`!!(${expression})`).pipe(
				Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(new WalkthroughStepFailed({ message: `timed out waiting for ${expression}` })))),
				Effect.retry({ schedule: Schedule.spaced(`${options.intervalMs ?? 250} millis`), times: Math.ceil((options.timeoutMs ?? 30_000) / (options.intervalMs ?? 250)) })
			),
		still: Effect.fnUntraced(function* (name, caption) {
			const s = yield* computer.screenshot().pipe(Effect.mapError(failed("screenshot")))
			const n = yield* Ref.updateAndGet(stillNo, (x) => x + 1)
			const file = `stills/${String(n).padStart(2, "0")}-${name}.png`
			yield* run.writeBytes(file, s.data).pipe(Effect.mapError(failed("write")))
			yield* Ref.update(report, (r) => ({ ...r, stills: [...r.stills, new Still({ file, caption: redact(caption, secrets), at: s.at })] }))
			yield* step("still", s.at, { file })
			return file
		}),
		note: (line) => Ref.update(report, (r) => ({ ...r, notes: [...r.notes, redact(line, secrets)] })),
		preview: (line) => Ref.update(report, (r) => ({ ...r, preview: line })),
		intro: (line) => Ref.update(report, (r) => ({ ...r, intro: line })),
	})

	yield* drainAll
	const outcome = yield* program.pipe(Effect.provideService(Walkthrough, service), Effect.result)
	yield* drainAll
	const error = outcome._tag === "Failure" ? Option.some(redact(String((outcome.failure as { message?: string })?.message ?? outcome.failure), secrets).slice(0, 500)) : Option.none<string>()
	if (Option.isSome(error)) yield* run.log("walkthrough.error", { message: error.value })

	// Anything declared but not finished is blocked, with the error if there was one.
	const plan = new Plan({ summary: change.task.split("\n")[0] ?? "", criteria: yield* Ref.get(declared) })
	const final = yield* Ref.get(results)
	const criteria = plan.criteria.map((c): CriterionResult => {
		const r = final.get(c.id)
		if (r?.endedAt !== undefined) return r
		const notes = Option.match(error, { onNone: () => "not reached by the walkthrough", onSome: (m) => `walkthrough stopped: ${m}` })
		return { id: c.id, status: "blocked", notes, beganAt: r?.beganAt, endedAt: r?.endedAt, screenshot: undefined, evidence: undefined, console: r?.console ?? [], network: r?.network ?? [], forced: "walkthrough", steps: 0 }
	})
	const r = yield* Ref.get(report)
	const notes = Option.match(error, { onNone: () => r.notes, onSome: (m) => [...r.notes, `Walkthrough error: ${m}`] })
	return {
		plan,
		exec: { criteria, console: yield* Ref.get(allConsole), network: yield* Ref.get(allNetwork), stoppedBecause: Option.isSome(error) ? "model_gave_up" : "done", summary: "" },
		report: new WalkthroughReport({ preview: r.preview, intro: r.intro, stills: r.stills, notes }),
		error,
	} satisfies WalkthroughOutcome
})
