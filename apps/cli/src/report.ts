// report.md in the "## Manual verification" format: a Preview line, one caption
// sentence above each still, the walkthrough video, notes. Media are ./relative
// paths; `witness publish` or `witness upload` swaps them for hosted URLs.
import { BlockedVerdict, RunInfo, type Verdict, Verdict as VerdictSchema, WalkthroughReport } from "@witness/domain"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { BEFORE_DIR } from "./verifier.ts"

const ICON: Record<string, string> = { blocked: "⚠️", fail: "❌", pass: "✅" }

const readJson = <A, I>(file: string, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const exists = yield* fs.exists(file)
		if (!exists) {
			return Option.none<A>()
		}
		return Option.some(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(yield* fs.readFileString(file)))
	})

/** The pieces of a finished run a report is built from. */
export const loadRun = Effect.fn("loadRun")(function* (runDir: string) {
	const path = yield* Path.Path
	const verdict = yield* readJson(path.join(runDir, "verdict.json"), VerdictSchema)
	const walk = yield* readJson(path.join(runDir, "walkthrough.json"), WalkthroughReport)
	const info = yield* readJson(path.join(runDir, "run.json"), RunInfo)
	return { info, verdict, walk }
})

/**
 * The base commit's run recorded inside `runDir` (`states: before-after`), if any:
 * its folder, and why it stopped when it never reached a verdict.
 */
export const beforeRun = Effect.fn("beforeRun")(function* (runDir: string) {
	const path = yield* Path.Path
	const dir = path.join(runDir, BEFORE_DIR)
	const file = path.join(dir, "verdict.json")
	const verdict = yield* readJson(file, VerdictSchema).pipe(Effect.orElseSucceed(() => Option.none()))
	if (Option.isSome(verdict)) {
		return Option.some({ blocked: Option.none<string>(), dir })
	}
	const blocked = yield* readJson(file, BlockedVerdict).pipe(Effect.orElseSucceed(() => Option.none()))
	return Option.map(blocked, (b) => ({ blocked: Option.some(b.notes), dir }))
})

/** The note a report carries when the before run never reached a verdict. */
export const beforeBlockedNote = (notes: string) =>
	`The base commit could not be checked, so there is no before state: ${notes}`

/**
 * `witness report`: report.md in `runDir`, pairing the before run's stills, verdicts
 * and video with this one's when the run recorded both.
 */
export const writeRunReport = Effect.fn("writeRunReport")(function* (runDir: string) {
	const before = yield* beforeRun(runDir)
	if (Option.isSome(before) && Option.isNone(before.value.blocked)) {
		return yield* writeComparisonReport({
			after: runDir,
			before: before.value.dir,
			intro: Option.none(),
			notes: [],
			outDir: runDir,
			preview: Option.none(),
		})
	}
	return yield* writeReport(
		runDir,
		Option.toArray(Option.flatMap(before, (b) => Option.map(b.blocked, beforeBlockedNote)))
	)
})

export const criteriaTable = (v: Verdict): string =>
	[
		"| Result | Criterion | Video | What was seen |",
		"|---|---|---|---|",
		...v.criteria.map(
			(c) =>
				`| ${ICON[c.status] ?? ""} ${c.status} | ${c.id}${c.kind === "regression" ? " (regression)" : ""} ${c.description} | ${Option.match(c.video_ts, { onNone: () => "–", onSome: ([a, b]) => `${a}s–${b}s of raw` })} | ${c.explanation.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`
		),
	].join("\n")

const alt = (caption: string) => caption.replace(/[[\]]/g, "")

/** Writes <runDir>/report.md for a single run. Returns its path. */
export const writeReport = Effect.fn("writeReport")(function* (runDir: string, extraNotes: readonly string[] = []) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { verdict, walk, info } = yield* loadRun(runDir)
	const out = ["## Manual verification"]
	out.push(
		Option.match(walk, {
			onNone: () =>
				`Preview: production build of \`${Option.match(info, { onNone: () => "?", onSome: (i) => i.sha.slice(0, 7) })}\` in a fresh Witness computer (run \`${path.basename(runDir)}\`).`,
			onSome: (w) => `Preview: ${w.preview}`,
		})
	)
	if (Option.isSome(walk) && walk.value.intro) {
		out.push(walk.value.intro)
	}
	const stills = Option.match(walk, {
		onNone: () =>
			Option.match(verdict, {
				onNone: () => [],
				onSome: (v) =>
					v.criteria.flatMap((c) =>
						Option.match(c.screenshot, {
							onNone: () => [],
							onSome: (shot) => [{ caption: `${c.id} ${c.status}: ${c.explanation}`, file: shot }],
						})
					),
			}),
		onSome: (w) => w.stills.map((s) => ({ caption: s.caption, file: s.file })),
	})
	for (const s of stills) {
		out.push(`${s.caption}\n\n![${alt(s.caption)}](./${s.file})`)
	}
	if (Option.isNone(walk) && Option.isSome(verdict)) {
		out.push(criteriaTable(verdict.value))
	}
	if (yield* fs.exists(path.join(runDir, "polished.mp4"))) {
		out.push("Walkthrough:\n\n./polished.mp4")
	}
	const notes = [...Option.match(walk, { onNone: () => [], onSome: (w) => w.notes }), ...extraNotes]
	if (Option.isNone(walk) && Option.isSome(verdict) && verdict.value.notes) {
		notes.push(verdict.value.notes)
	}
	if (notes.length) {
		out.push(notes.map((n) => `- ${n}`).join("\n"))
	}
	const file = path.join(runDir, "report.md")
	yield* fs.writeFileString(file, `${out.join("\n\n")}\n`)
	return file
})

/**
 * Before/after report from two runs of the same walkthrough: stills paired by name,
 * a criteria table with both statuses, both videos. Copies every referenced file
 * into `outDir/media`, so the folder is self-contained.
 */
export const writeComparisonReport = Effect.fn("writeComparisonReport")(function* (opts: {
	readonly before: string
	readonly after: string
	readonly outDir: string
	readonly preview: Option.Option<string>
	readonly intro: Option.Option<string>
	readonly notes: readonly string[]
}) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const b = yield* loadRun(opts.before)
	const a = yield* loadRun(opts.after)
	yield* fs.makeDirectory(path.join(opts.outDir, "media"), { recursive: true })
	const copy = Effect.fnUntraced(function* (runDir: string, media: string, prefix: string) {
		const name = `${prefix}-${path.basename(media)}`
		if (yield* fs.exists(path.join(runDir, media))) {
			yield* fs.copyFile(path.join(runDir, media), path.join(opts.outDir, "media", name))
		}
		return `./media/${name}`
	})

	const out = ["## Manual verification"]
	out.push(
		`Preview: ${Option.getOrElse(opts.preview, () => `before = ${Option.match(b.info, { onNone: () => "?", onSome: (i) => i.sha.slice(0, 7) })}; after = ${Option.match(a.info, { onNone: () => "?", onSome: (i) => i.sha.slice(0, 7) })}`)}`
	)
	const intro = Option.orElse(opts.intro, () =>
		Option.flatMap(a.walk, (w) => (w.intro ? Option.some(w.intro) : Option.none()))
	)
	if (Option.isSome(intro)) {
		out.push(intro.value)
	}

	// Stills pair by name (a walkthrough's still names, or the criterion of an agent run's screenshot).
	const stillsOf = (r: typeof a) =>
		Option.match(r.walk, {
			onNone: () =>
				Option.match(r.verdict, {
					onNone: () => [],
					onSome: (v) =>
						v.criteria.flatMap((c) =>
							Option.match(c.screenshot, {
								onNone: () => [],
								onSome: (shot) => [{ caption: `${c.id} ${c.status}: ${c.explanation}`, file: shot, key: c.id }],
							})
						),
				}),
			onSome: (w) =>
				w.stills.map((s) => ({ caption: s.caption, file: s.file, key: path.basename(s.file).replace(/^\d+-/, "") })),
		})
	const still = Effect.fnUntraced(function* (
		side: "Before" | "After",
		runDir: string,
		s: { readonly caption: string; readonly file: string }
	) {
		const caption = `**${side}:** ${s.caption}`
		return `${caption}\n\n![${alt(s.caption)}](${yield* copy(runDir, s.file, side.toLowerCase())})`
	})
	const beforeStills = new Map(stillsOf(b).map((s) => [s.key, s] as const))
	for (const s of stillsOf(a)) {
		const before = beforeStills.get(s.key)
		if (before) {
			beforeStills.delete(s.key)
			out.push(yield* still("Before", opts.before, before))
		}
		out.push(yield* still("After", opts.after, s))
	}
	// Before stills with no counterpart still show what the base commit did.
	for (const s of beforeStills.values()) {
		out.push(yield* still("Before", opts.before, s))
	}

	if (Option.isSome(a.verdict)) {
		const bv = new Map(
			Option.match(b.verdict, { onNone: () => [], onSome: (v) => v.criteria.map((c) => [c.id, c] as const) })
		)
		const cell = (x: { readonly status: string; readonly explanation: string } | undefined) =>
			x ? `${ICON[x.status] ?? ""} ${x.status}: ${x.explanation.replace(/\|/g, "\\|")}` : "–"
		out.push(
			[
				"| Criterion | Before | After |",
				"|---|---|---|",
				...a.verdict.value.criteria.map(
					(c) =>
						`| ${c.id}${c.kind === "regression" ? " (regression)" : ""} ${c.description} | ${cell(bv.get(c.id))} | ${cell(c)} |`
				),
			].join("\n")
		)
	}
	for (const [label, dir] of [
		["after", opts.after],
		["before", opts.before],
	] as const) {
		if (!(yield* fs.exists(path.join(dir, "polished.mp4")))) {
			continue
		}
		yield* fs.copyFile(path.join(dir, "polished.mp4"), path.join(opts.outDir, "media", `${label}.mp4`))
		if (yield* fs.exists(path.join(dir, "preview.gif"))) {
			yield* fs.copyFile(path.join(dir, "preview.gif"), path.join(opts.outDir, "media", `${label}.gif`))
		}
		out.push(`Walkthrough (${label}):\n\n./media/${label}.mp4`)
	}
	const notes = [
		...new Set([
			...Option.match(a.walk, { onNone: () => [], onSome: (w) => w.notes }),
			...Option.match(b.walk, { onNone: () => [], onSome: (w) => w.notes }),
			...opts.notes,
		]),
	]
	if (notes.length) {
		out.push(notes.map((n) => `- ${n}`).join("\n"))
	}
	const file = path.join(opts.outDir, "report.md")
	yield* fs.writeFileString(file, `${out.join("\n\n")}\n`)
	return file
})
