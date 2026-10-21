// The recorded tester. The agent's tool loop and a session driven by `witness act`
// both act on the app through this one surface, so the recording, the step log,
// the evidence and the rules come out the same either way:
// - input goes through the real mouse and keyboard, so the video shows it;
// - navigation stays on the app under test;
// - the test password is typed only by `TypeSecret`, never appears in a label or
//   in typed text, and is masked in page text, logs and notes;
// - a criterion that was never ended is ended blocked, with a screenshot.
// Coordinates in and out are screenshot pixels (`ShotSpace`), not screen pixels.
import {
	type Computer,
	type ConsoleMessage,
	type NetworkEvent,
	type PageElement,
	SCREEN,
	type Screenshot,
	type ShotOptions,
} from "@witness/computer"
import {
	type Criterion,
	type CriterionStatus,
	redact,
	redactDeep,
	type StepTool,
	Still,
	WalkthroughReport,
	type WitnessConfig,
} from "@witness/domain"
import { Clock, Context, Data, Effect, Option, Ref, Schema } from "effect"
import { type CriterionRecord, pendingRecord } from "./criteria.ts"
import { CurrentRun } from "./current-run.ts"
import { type StepInput, Steps } from "./steps.ts"

/** An action was refused (it broke a rule or named something unknown) or the computer could not do it. */
export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", { message: Schema.String }) {}

/** Screenshot pixels the tester sees, mapped onto the 1920x1080 screen. */
export const shotSpace = (width: number) => {
	const scale = SCREEN.width / width
	return {
		height: Math.round((width * 9) / 16),
		toImage: (v: number) => Math.round(v / scale),
		toScreen: (v: number) => Math.round(v * scale),
		width,
	}
}
export type ShotSpace = ReturnType<typeof shotSpace>

type Point = { readonly x: number; readonly y: number }
type NoArgs = Record<never, never>

/** Everything a tester can do. Points are in screenshot pixels. */
export type ToolCall = Data.TaggedEnum<{
	Screenshot: NoArgs
	Click: Point & { readonly button: "click" | "double_click" | "right_click"; readonly label: string }
	/** Clicks an element from the latest snapshot by its ref (an empty label captions it with the element's name). */
	ClickRef: { readonly ref: string; readonly label: string }
	/** Clicks the first enabled element whose name contains `text` (waits up to 5 s for it). */
	ClickText: { readonly text: string; readonly label: string }
	Type: { readonly text: string; readonly label: string }
	TypeSecret: { readonly label: string }
	Key: { readonly combo: string; readonly label: string }
	Scroll: { readonly dy: number; readonly at: Option.Option<Point>; readonly label: string }
	Drag: Point & { readonly toX: number; readonly toY: number; readonly label: string }
	Navigate: { readonly url: string; readonly label: string }
	Wait: { readonly ms: number; readonly label: Option.Option<string> }
	Snapshot: { readonly maxText: number }
	ConsoleLogs: NoArgs
	NetworkErrors: NoArgs
	AppLogs: { readonly tail: number; readonly file: string }
	Evaluate: { readonly expression: string }
	/** Declares a criterion, or rewords one already declared. */
	Declare: { readonly criterion: Criterion }
	Begin: { readonly id: string }
	End: {
		readonly id: string
		readonly status: CriterionStatus
		readonly notes: string
		/** Set when the orchestrator, not the tester, ends it. */
		readonly forced: Option.Option<string>
	}
	/** A full-resolution still for the report, with the sentence that says what it proves. */
	Still: { readonly name: string; readonly caption: string }
	Note: { readonly line: string }
	Preview: { readonly line: string }
	Intro: { readonly line: string }
}>
export const ToolCall = Data.taggedEnum<ToolCall>()

const VISIBLE = new Set<ToolCall["_tag"]>([
	"Screenshot",
	"Click",
	"ClickRef",
	"ClickText",
	"Type",
	"TypeSecret",
	"Key",
	"Scroll",
	"Drag",
	"Navigate",
	"Wait",
])
/** Whether a call acts on the screen (and so returns a screenshot and counts as a step). */
export const isVisible = (call: ToolCall) => VISIBLE.has(call._tag)

/** What a call returns: text for the tester, and the screen after a visible action. */
export type Performed = { readonly text: string; readonly screen: Option.Option<Screenshot> }

/** Page text and interactive elements, as the tester reads them. Page content is untrusted. */
export const snapshotText = (
	snap: {
		readonly url: string
		readonly title: string
		readonly text: string
		readonly elements: readonly PageElement[]
	},
	space: ShotSpace
) => {
	const lines = snap.elements.map((e) => {
		const flags = [e.disabled ? "disabled" : "", e.checked ? "checked" : ""].filter(Boolean).join(",")
		return `${e.ref} ${e.role ?? e.tag}${e.type ? `[${e.type}]` : ""} ${JSON.stringify(e.name)}${e.value ? ` value=${JSON.stringify(e.value)}` : ""}${flags ? ` (${flags})` : ""} @(${space.toImage(e.x)},${space.toImage(e.y)})`
	})
	return `URL: ${snap.url}\nTitle: ${snap.title}\n<untrusted kind="page-text">\n${snap.text}\n</untrusted>\nInteractive elements:\n${lines.join("\n") || "(none)"}`
}

/** A failed request as the tester and the reviewer read it. */
export const networkLine = (e: NetworkEvent) => `${e.method} ${e.url} -> ${e.status ?? e.error}`

const untrusted = (kind: string, body: string) => `<untrusted kind="${kind}">\n${body}\n</untrusted>`

export type RecorderState = {
	readonly active: Option.Option<string>
	readonly records: ReadonlyMap<string, CriterionRecord>
	readonly unfinished: readonly Criterion[]
}

/** What the recorder hands back once the checking is over. */
export type Recorded = {
	readonly records: readonly CriterionRecord[]
	readonly console: readonly ConsoleMessage[]
	readonly network: readonly NetworkEvent[]
	readonly report: WalkthroughReport
}

export type RecorderApi = {
	readonly runDir: string
	/** The screen when the recorder started. */
	readonly first: Screenshot
	readonly state: Effect.Effect<RecorderState>
	perform: (call: ToolCall) => Effect.Effect<Performed, ActionFailed>
	/** Ends every unfinished criterion blocked (`forced`, `notes`) and returns what was recorded. */
	finish: (forced: string, notes: string) => Effect.Effect<Recorded>
}

/** The recorder, for programs that drive a session. */
export class Recorder extends Context.Service<Recorder, RecorderApi>()("witness/orchestrator/Recorder") {}

/** A recorder over `computer`, checking `criteria` (more can be declared). Start it once the recording runs. */
export const makeRecorder = Effect.fn("makeRecorder")(function* (
	computer: Computer,
	config: WitnessConfig,
	criteria: readonly Criterion[],
	imageWidth: number
) {
	const run = yield* CurrentRun
	const steps = yield* Steps
	const secrets = yield* run.secrets
	const space = shotSpace(imageWidth)
	const shot: ShotOptions = { format: "jpeg", quality: 80, width: imageWidth }
	const secret = Option.flatMap(config.login, (l) => Option.fromUndefinedOr(l.password))
	const allowedHosts = new Set([
		new URL(config.url).hostname,
		"localhost",
		"127.0.0.1",
		...Object.keys(config.services),
	])
	const failed = (what: string) => (e: { readonly message: string }) =>
		new ActionFailed({ message: `${what}: ${e.message}` })
	const reject = (message: string) => Effect.fail(new ActionFailed({ message }))

	const sent = yield* Clock.currentTimeMillis
	const first = yield* computer.screenshot(shot).pipe(Effect.orDie)
	// Computer clock minus host clock, measured at the request's midpoint.
	const offset = first.at - (sent + (yield* Clock.currentTimeMillis)) / 2
	const now = Clock.currentTimeMillis.pipe(Effect.map((t) => t + offset))

	const declared = yield* Ref.make<readonly Criterion[]>(criteria)
	const records = yield* Ref.make(new Map(criteria.map((c) => [c.id, pendingRecord(c)])))
	const active = yield* Ref.make<Option.Option<string>>(Option.none())
	const elements = yield* Ref.make(new Map<string, PageElement>())
	const allConsole = yield* Ref.make<readonly ConsoleMessage[]>([])
	const allNetwork = yield* Ref.make<readonly NetworkEvent[]>([])
	const report = yield* Ref.make(new WalkthroughReport({ intro: "", notes: [], preview: "", stills: [] }))
	const stillNo = yield* Ref.make(0)

	const update = (id: string, f: (r: CriterionRecord) => CriterionRecord) =>
		Ref.update(records, (m) => {
			const r = m.get(id)
			return r ? new Map(m).set(id, f(r)) : m
		})
	const state = Effect.gen(function* () {
		const m = yield* Ref.get(records)
		return {
			active: yield* Ref.get(active),
			records: m,
			unfinished: (yield* Ref.get(declared)).filter((c) => m.get(c.id)?.endedAt === undefined),
		} satisfies RecorderState
	})

	/** Console messages and failed requests since the last drain, kept on the active criterion too. */
	const drain = Effect.gen(function* () {
		const [c, n] = yield* Effect.all([
			computer.consoleMessages.pipe(Effect.orElseSucceed(() => [])),
			computer.networkEvents.pipe(Effect.orElseSucceed(() => [])),
		])
		yield* Ref.update(allConsole, (a) => [...a, ...c])
		yield* Ref.update(allNetwork, (a) => [...a, ...n])
		const id = yield* Ref.get(active)
		if (Option.isSome(id)) {
			yield* update(id.value, (r) => ({ ...r, console: [...r.console, ...c], network: [...r.network, ...n] }))
		}
		return { console: c, network: n }
	})

	const step = (input: Omit<StepInput, "criterion">) =>
		Effect.gen(function* () {
			const crit = yield* Ref.get(active)
			yield* steps
				.add({
					...input,
					...(input.label === undefined ? {} : { label: input.label.slice(0, 120) }),
					...(Option.isSome(crit) ? { criterion: crit.value } : {}),
				})
				.pipe(Effect.mapError(failed("step log")))
		})

	/** A visible action: performs it, counts it on the active criterion and logs it. */
	const visible = Effect.fnUntraced(function* (
		action: Parameters<Computer["act"]>[0]["action"],
		entry: { readonly tool: StepTool; readonly label: string } & Partial<StepInput>
	) {
		const s = yield* computer.act({ action, shot }).pipe(Effect.mapError(failed(action.type)))
		yield* countStep
		yield* step({ at: s.actionAt ?? s.at, ...entry })
		return s
	})
	const countStep = Effect.gen(function* () {
		const id = yield* Ref.get(active)
		if (Option.isSome(id)) {
			yield* update(id.value, (r) => ({ ...r, steps: r.steps + 1 }))
		}
	})

	const findElement = Effect.fnUntraced(function* (text: string, timeoutMs: number) {
		const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
		for (;;) {
			const snap = yield* computer.pageSnapshot(100).pipe(Effect.mapError(failed("snapshot")))
			const el = snap.elements.find((e) => e.name.toLowerCase().includes(text.toLowerCase()) && !e.disabled)
			if (el) {
				return el
			}
			if ((yield* Clock.currentTimeMillis) > deadline) {
				return yield* reject(
					`no element matching ${JSON.stringify(text)} on ${snap.url}; saw: ${snap.elements
						.map((e) => e.name)
						.filter(Boolean)
						.slice(0, 30)
						.join(" | ")}`
				)
			}
			yield* Effect.sleep("300 millis")
		}
	})

	const end = Effect.fnUntraced(function* (
		id: string,
		status: CriterionStatus,
		notes: string,
		forced: Option.Option<string>
	) {
		yield* drain
		const full = yield* computer.screenshot().pipe(Effect.mapError(failed("screenshot")))
		const evidence = yield* computer.screenshot(shot).pipe(Effect.option)
		const file = `${id.toLowerCase()}-${status}.png`
		yield* run.writeBytes(file, full.data).pipe(Effect.mapError(failed("write")))
		const clean = redact(notes, secrets)
		yield* update(id, (r) => ({
			...r,
			endedAt: full.at,
			evidence: Option.getOrUndefined(evidence),
			forced: Option.getOrUndefined(forced),
			notes: clean,
			screenshot: file,
			status,
		}))
		yield* step({
			at: full.at,
			label: `${id}: ${status.toUpperCase()}`,
			notes: clean,
			status,
			tool: "end_criterion",
			...Option.match(forced, { onNone: () => ({}), onSome: (f) => ({ forced: f }) }),
		})
		yield* Ref.set(active, Option.none())
	})

	const screenOf = (s: Screenshot): Performed => ({ screen: Option.some(s), text: "Done." })

	const dispatch = (call: ToolCall): Effect.Effect<Performed, ActionFailed> =>
		ToolCall.$match(call, {
			AppLogs: ({ file, tail }) =>
				Effect.gen(function* () {
					const n = Math.max(1, Math.min(300, Math.round(tail) || 100))
					const lines = yield* computer.logs(file, n).pipe(Effect.orElseSucceed(() => ""))
					yield* step({ at: yield* now, tail: n, tool: "app_logs" })
					return { screen: Option.none(), text: untrusted("app-log", redact(lines, secrets).slice(-12_000)) }
				}),
			Begin: ({ id }) =>
				Effect.gen(function* () {
					const s = yield* state
					const c = (yield* Ref.get(declared)).find((x) => x.id === id)
					if (!c) {
						return yield* reject(`Unknown criterion ${id}. Declared: ${[...s.records.keys()].join(", ") || "none"}.`)
					}
					if (Option.isSome(s.active) && s.active.value !== id) {
						return yield* reject(`End ${s.active.value} first.`)
					}
					if (s.records.get(id)?.endedAt !== undefined) {
						return yield* reject(`${id} is already ended.`)
					}
					// Console noise from before this criterion is not its fault.
					yield* drain
					const beganAt = yield* now
					yield* Ref.update(records, (m) => new Map(m).set(id, { ...pendingRecord(c), beganAt }))
					yield* Ref.set(active, Option.some(id))
					yield* step({ at: beganAt, label: `${id}: ${c.description}`, tool: "begin_criterion" })
					return { screen: Option.none(), text: `Started ${id}.` }
				}),
			Click: ({ button, label, x, y }) => {
				const p = { x: space.toScreen(x), y: space.toScreen(y) }
				return visible({ type: button, ...p }, { label, tool: button, ...p }).pipe(Effect.map(screenOf))
			},
			ClickRef: ({ label, ref }) =>
				Effect.gen(function* () {
					const el = (yield* Ref.get(elements)).get(ref)
					if (!el) {
						return yield* reject(`Unknown ref ${ref}. Take a page snapshot first; refs change after every snapshot.`)
					}
					const s = yield* visible(
						{ type: "click", x: el.x, y: el.y },
						{ label: label || `Click "${el.name.slice(0, 40)}"`, tool: "click_element", x: el.x, y: el.y }
					)
					return { screen: Option.some(s), text: `Clicked ${ref} ${JSON.stringify(el.name)}.` }
				}),
			ClickText: ({ label, text }) =>
				Effect.gen(function* () {
					const el = yield* findElement(text, 5000)
					const s = yield* visible({ type: "click", x: el.x, y: el.y }, { label, tool: "click", x: el.x, y: el.y })
					return { screen: Option.some(s), text: `Clicked ${el.ref} ${JSON.stringify(el.name)}.` }
				}),
			ConsoleLogs: () =>
				Effect.gen(function* () {
					const { console: c } = yield* drain
					yield* step({ at: yield* now, count: c.length, tool: "console_logs" })
					const body = c.map((m) => `[${m.type}] ${m.text}`).join("\n")
					return {
						screen: Option.none(),
						text: c.length ? untrusted("console", redact(body, secrets).slice(0, 8000)) : "No new console messages.",
					}
				}),
			Declare: ({ criterion: c }) =>
				Effect.gen(function* () {
					yield* Ref.update(declared, (d) =>
						d.some((x) => x.id === c.id) ? d.map((x) => (x.id === c.id ? c : x)) : [...d, c]
					)
					yield* Ref.update(records, (m) => {
						const r = m.get(c.id)
						return new Map(m).set(c.id, r ? { ...r, criterion: c } : pendingRecord(c))
					})
					yield* run.log("criterion.declared", { description: c.description, id: c.id, kind: c.kind })
					return { screen: Option.none(), text: `Declared ${c.id} (${c.kind}).` }
				}),
			Drag: ({ label, toX, toY, x, y }) => {
				const p = { to_x: space.toScreen(toX), to_y: space.toScreen(toY), x: space.toScreen(x), y: space.toScreen(y) }
				return visible({ type: "drag", ...p }, { label, tool: "drag", ...p }).pipe(Effect.map(screenOf))
			},
			End: ({ forced, id, notes, status }) =>
				Effect.gen(function* () {
					const current = yield* Ref.get(active)
					if (!Option.contains(current, id)) {
						return yield* reject(
							Option.match(current, {
								onNone: () => `Begin ${id} first.`,
								onSome: (a) => `The active criterion is ${a}.`,
							})
						)
					}
					yield* end(id, status, notes, forced)
					const left = (yield* state).unfinished.map((c) => c.id)
					return {
						screen: Option.none(),
						text: left.length ? `Ended ${id}. Remaining: ${left.join(", ")}.` : `Ended ${id}. All criteria are ended.`,
					}
				}),
			Evaluate: ({ expression }) =>
				computer.evaluate(expression).pipe(
					Effect.mapError(failed("evaluate")),
					Effect.map((v) => ({
						screen: Option.none(),
						text: String(JSON.stringify(redactDeep(v, secrets), null, 1)),
					}))
				),
			Intro: ({ line }) =>
				Ref.update(report, (r) => new WalkthroughReport({ ...r, intro: redact(line, secrets) })).pipe(
					Effect.as({ screen: Option.none(), text: "Set." })
				),
			Key: ({ combo, label }) =>
				visible({ combo, type: "key" }, { combo, label, tool: "key" }).pipe(Effect.map(screenOf)),
			Navigate: ({ label, url }) =>
				Effect.gen(function* () {
					const target = Option.liftThrowable((u: string) => new URL(u, config.url))(url)
					if (
						Option.isNone(target) ||
						!/^https?:$/.test(target.value.protocol) ||
						!allowedHosts.has(target.value.hostname)
					) {
						return yield* reject(`Only the app under test may be opened (${[...allowedHosts].join(", ")}).`)
					}
					const nav = yield* computer
						.navigate(target.value.toString(), 60_000)
						.pipe(Effect.mapError(failed("navigate")))
					const s = yield* computer.screenshot(shot).pipe(Effect.mapError(failed("screenshot")))
					yield* countStep
					yield* step({
						at: nav.at,
						http_status: nav.status ?? null,
						label,
						tool: "navigate",
						url: target.value.toString(),
					})
					return {
						screen: Option.some(s),
						text: nav.error ? `Navigation error: ${nav.error}` : `Opened ${nav.url} (HTTP ${nav.status ?? "?"}).`,
					}
				}),
			NetworkErrors: () =>
				Effect.gen(function* () {
					const { network: n } = yield* drain
					yield* step({ at: yield* now, count: n.length, tool: "network_errors" })
					const body = n.map(networkLine).join("\n")
					return {
						screen: Option.none(),
						text: n.length ? untrusted("network", redact(body, secrets).slice(0, 8000)) : "No new failed requests.",
					}
				}),
			Note: ({ line }) =>
				Ref.update(report, (r) => new WalkthroughReport({ ...r, notes: [...r.notes, redact(line, secrets)] })).pipe(
					Effect.as({ screen: Option.none(), text: "Noted." })
				),
			Preview: ({ line }) =>
				Ref.update(report, (r) => new WalkthroughReport({ ...r, preview: redact(line, secrets) })).pipe(
					Effect.as({ screen: Option.none(), text: "Set." })
				),
			Screenshot: () =>
				Effect.gen(function* () {
					const s = yield* computer.screenshot(shot).pipe(Effect.mapError(failed("screenshot")))
					yield* countStep
					yield* step({ at: s.at, tool: "screenshot" })
					return screenOf(s)
				}),
			Scroll: ({ at, dy, label }) => {
				const p = Option.match(at, {
					onNone: () => ({}),
					onSome: (a) => ({ x: space.toScreen(a.x), y: space.toScreen(a.y) }),
				})
				return visible({ dy, type: "scroll", ...p }, { label, tool: "scroll", ...p }).pipe(Effect.map(screenOf))
			},
			Snapshot: ({ maxText }) =>
				Effect.gen(function* () {
					const snap = yield* computer.pageSnapshot(maxText).pipe(Effect.mapError(failed("snapshot")))
					yield* Ref.set(elements, new Map(snap.elements.map((e) => [e.ref, e])))
					yield* step({ at: yield* now, tool: "page_snapshot" })
					return { screen: Option.none(), text: snapshotText({ ...snap, text: redact(snap.text, secrets) }, space) }
				}),
			Still: ({ caption, name }) =>
				Effect.gen(function* () {
					const s = yield* computer.screenshot().pipe(Effect.mapError(failed("screenshot")))
					const n = yield* Ref.updateAndGet(stillNo, (x) => x + 1)
					const file = `stills/${String(n).padStart(2, "0")}-${name.replace(/[^\w-]+/g, "-")}.png`
					yield* run.writeBytes(file, s.data).pipe(Effect.mapError(failed("write")))
					yield* Ref.update(
						report,
						(r) =>
							new WalkthroughReport({
								...r,
								stills: [...r.stills, new Still({ at: s.at, caption: redact(caption, secrets), file })],
							})
					)
					yield* step({ at: s.at, file, tool: "still" })
					return { screen: Option.none(), text: file }
				}),
			Type: ({ label, text }) =>
				Option.isSome(secret) && text.includes(secret.value)
					? reject("Do not type the password as text; use type_secret.")
					: visible({ text, type: "type" }, { chars: text.length, label, tool: "type" }).pipe(Effect.map(screenOf)),
			TypeSecret: ({ label }) =>
				Option.match(secret, {
					onNone: () => reject("No login password is configured in witness.yaml."),
					onSome: (s) => visible({ text: s, type: "type" }, { label, tool: "type_secret" }).pipe(Effect.map(screenOf)),
				}),
			Wait: ({ label, ms }) =>
				Effect.gen(function* () {
					const s = yield* computer
						.act({ action: { ms: Math.max(100, Math.min(10_000, Math.round(ms))), type: "wait" }, settle_ms: 0, shot })
						.pipe(Effect.mapError(failed("wait")))
					yield* countStep
					if (Option.isSome(label)) {
						yield* step({ at: s.actionAt ?? s.at, label: label.value, tool: "wait" })
					}
					return screenOf(s)
				}),
		})

	const labelOf = (call: ToolCall): string =>
		call._tag === "Wait" ? Option.getOrElse(call.label, () => "") : "label" in call ? call.label : ""

	const perform = (call: ToolCall): Effect.Effect<Performed, ActionFailed> =>
		Option.isSome(secret) && labelOf(call).includes(secret.value)
			? reject("Labels must not contain secrets. Rewrite the label.")
			: dispatch(call)

	const finish = Effect.fn("Recorder.finish")(function* (forced: string, notes: string) {
		for (const c of (yield* state).unfinished) {
			yield* Ref.set(active, Option.some(c.id))
			yield* end(c.id, "blocked", notes, Option.some(forced)).pipe(
				Effect.catch((e) => run.log("criterion.end_failed", { id: c.id, message: e.message }))
			)
		}
		yield* Ref.set(active, Option.none())
		yield* drain
		const m = yield* Ref.get(records)
		return {
			console: yield* Ref.get(allConsole),
			network: yield* Ref.get(allNetwork),
			records: (yield* Ref.get(declared)).map((c) => m.get(c.id) ?? pendingRecord(c)),
			report: yield* Ref.get(report),
		} satisfies Recorded
	})

	// Boot noise is not blamed on the first criterion.
	yield* drain
	return { finish, first, perform, runDir: run.dir, state } satisfies RecorderApi
})
