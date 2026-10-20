// Reports for PRs, all built from one ReportManifest:
// - report.md, the "## Manual verification" section, with media next to it;
// - the hosted report (`witness upload`) and the short PR section that links it.
// A before/after pairs each still with its before and shows both verdicts.
import {
	criterionLabel,
	evidenceStills,
	isVerdict,
	type LoadedRun,
	mdCell,
	mmss,
	pairSides,
	ReportManifest,
	ReportSection,
	ReportStill,
	RUN_FILES,
	type RunPair,
	reportTitle,
	STATUS_ICON,
	type Verdict,
} from "@witness/domain"
import { readRenderedCut } from "@witness/renderer"
import { Effect, FileSystem, Option, Path, Schema } from "effect"

/** A run cannot be reported (it never reached a verdict). */
export class ReportError extends Schema.TaggedError<ReportError>()("ReportError", { message: Schema.String }) {}

/** A report's manifest, and the file on disk behind each media name it uses. */
export type BuiltReport = { readonly manifest: ReportManifest; readonly media: ReadonlyMap<string, string> }

export type ReportOptions = {
	readonly title: Option.Option<string>
	readonly preview: Option.Option<string>
	readonly intro: Option.Option<string>
	readonly pr: Option.Option<string>
	readonly repo: Option.Option<string>
	readonly notes: readonly string[]
}

export const noReportOptions: ReportOptions = {
	intro: Option.none(),
	notes: [],
	pr: Option.none(),
	preview: Option.none(),
	repo: Option.none(),
	title: Option.none(),
}

const nonEmpty = (s: string) => (s ? Option.some(s) : Option.none())

/** One run as a report section; media names are prefixed with its label so a pair's files never collide. */
const sectionOf = Effect.fnUntraced(function* (run: LoadedRun, label: string, media: Map<string, string>) {
	const path = yield* Path.Path
	if (!isVerdict(run.result)) {
		return yield* new ReportError({ message: `${run.dir} never reached a verdict: ${run.result.notes}` })
	}
	const add = (file: string, name: string) => {
		media.set(name, path.join(run.dir, file))
		return name
	}
	const cut = yield* readRenderedCut(run.dir).pipe(Effect.mapError((e) => new ReportError({ message: e.message })))
	return new ReportSection({
		label,
		seek: Option.match(cut, { onNone: () => ({}), onSome: (c) => c.seek }),
		sha: run.info.sha,
		stills: evidenceStills(run).map(
			(s) => new ReportStill({ ...s, file: add(s.file, `${label}-${path.basename(s.file)}`) })
		),
		verdict: run.result,
		...Option.match(run.media.polished, {
			onNone: () => ({}),
			onSome: (f) => ({ video: add(f, `${label}-video.mp4`) }),
		}),
		...Option.match(run.media.gif, { onNone: () => ({}), onSome: (f) => ({ gif: add(f, `${label}-preview.gif`) }) }),
		...Option.match(run.media.captions, {
			onNone: () => ({}),
			onSome: (f) => ({ captions: add(f, `${label}-captions.vtt`) }),
		}),
	})
})

/** The report of a run pair: the change first (its verdict is the one that counts), then the base commit. */
export const buildReport = Effect.fn("buildReport")(function* (pair: RunPair, o: ReportOptions) {
	const path = yield* Path.Path
	const media = new Map<string, string>()
	const sides = pairSides(pair)
	const sections = yield* Effect.forEach([...sides].reverse(), (s) => sectionOf(s.run, s.label, media))
	const after = pair.after
	const walks = sides.flatMap((s) => Option.toArray(s.run.walk)).reverse()
	const shortSha = (r: LoadedRun) => r.info.sha.slice(0, 7)
	const defaultPreview = Option.match(pair.before, {
		onNone: () =>
			`production build of \`${shortSha(after)}\` in a fresh Witness computer (run \`${path.basename(after.dir)}\`).`,
		onSome: (b) => `before = ${shortSha(b)}; after = ${shortSha(after)}`,
	})
	// A run without a walkthrough has the reviewer's notes instead.
	const verdictNotes =
		Option.isNone(after.walk) && isVerdict(after.result) ? Option.toArray(nonEmpty(after.result.notes)) : []
	const manifest = new ReportManifest({
		createdAt: new Date().toISOString(),
		intro: Option.getOrElse(o.intro, () => Option.match(after.walk, { onNone: () => "", onSome: (w) => w.intro })),
		notes: [...new Set([...walks.flatMap((w) => w.notes), ...verdictNotes, ...pair.notes, ...o.notes])],
		preview: Option.getOrElse(
			Option.orElse(o.preview, () => Option.firstSomeOf(walks.map((w) => nonEmpty(w.preview)))),
			() => defaultPreview
		),
		sections: [sections[0]!, ...sections.slice(1)],
		title: Option.getOrElse(o.title, () => reportTitle(after.info.task)),
		...Option.match(
			Option.orElse(o.repo, () => Option.some(path.basename(after.info.repo))),
			{
				onNone: () => ({}),
				onSome: (repo) => ({ repo }),
			}
		),
		...Option.match(o.pr, { onNone: () => ({}), onSome: (pr) => ({ pr }) }),
	})
	return { manifest, media } satisfies BuiltReport
})

const alt = (caption: string) => caption.replace(/[[\]]/g, "")
const seekCell = (s: ReportSection, id: string) => {
	const at = s.seek[id]
	return at ? `${mmss(at[0])}–${mmss(at[1])}` : "–"
}

/** The criteria of the section that counts: result, criterion, where the video shows it, what was seen. */
const criteriaTable = (s: ReportSection) =>
	[
		"| Result | Criterion | Video | What was seen |",
		"|---|---|---|---|",
		...s.verdict.criteria.map(
			(c) =>
				`| ${STATUS_ICON[c.status]} ${c.status} | ${criterionLabel(c)} ${mdCell(c.description)} | ${seekCell(s, c.id)} | ${mdCell(c.explanation)} |`
		),
	].join("\n")

/** Each criterion's before and after status side by side. */
const comparisonTable = (after: Verdict, before: Verdict) => {
	const was = new Map(before.criteria.map((c) => [c.id, c] as const))
	const cell = (x: { readonly status: Verdict["overall"]; readonly explanation: string } | undefined) =>
		x ? `${STATUS_ICON[x.status]} ${x.status}: ${mdCell(x.explanation)}` : "–"
	return [
		"| Criterion | Before | After |",
		"|---|---|---|",
		...after.criteria.map(
			(c) => `| ${criterionLabel(c)} ${mdCell(c.description)} | ${cell(was.get(c.id))} | ${cell(c)} |`
		),
	].join("\n")
}

/** report.md's text. `href` turns a media name into the link the file is read from. Pure. */
export const reportMarkdown = (m: ReportManifest, href: (name: string) => string): string => {
	const [after, before] = [m.sections[0], m.sections[1]]
	const out = ["## Manual verification", `Preview: ${m.preview}`]
	if (m.intro) {
		out.push(m.intro)
	}
	const still = (s: ReportStill, side: string | undefined) =>
		`${side ? `**${side}:** ` : ""}${s.caption}\n\n![${alt(s.caption)}](${href(s.file)})`
	if (before) {
		// Stills pair by key; before stills with no counterpart still show what the base commit did.
		const unpaired = new Map(before.stills.map((s) => [s.key, s] as const))
		for (const s of after.stills) {
			const was = unpaired.get(s.key)
			if (was) {
				unpaired.delete(s.key)
				out.push(still(was, "Before"))
			}
			out.push(still(s, "After"))
		}
		out.push(...[...unpaired.values()].map((s) => still(s, "Before")))
		out.push(comparisonTable(after.verdict, before.verdict))
	} else {
		out.push(...after.stills.map((s) => still(s, undefined)))
		out.push(criteriaTable(after))
	}
	for (const s of m.sections) {
		if (s.video) {
			out.push(`${before ? `Walkthrough (${s.label})` : "Walkthrough"}:\n\n${href(s.video)}`)
		}
	}
	if (m.notes.length) {
		out.push(m.notes.map((n) => `- ${n}`).join("\n"))
	}
	return `${out.join("\n\n")}\n`
}

/** The PR section for a hosted report: verdict, criteria and a link; media stay on the page. Pure. */
export const hostedSection = (m: ReportManifest, url: string): string => {
	const main = m.sections[0]
	const out = ["## Manual verification"]
	if (m.preview) {
		out.push(`Preview: ${m.preview}`)
	}
	if (main.gif) {
		out.push(`[![Walkthrough preview](${url}/${main.gif})](${url})`)
	}
	// A before/after names each verdict; a single run doesn't need its "run" label.
	const many = m.sections.length > 1
	const verdicts = m.sections.map(
		(s) => `${many && s.label ? `${s.label}: ` : ""}${STATUS_ICON[s.verdict.overall]} **${s.verdict.overall}**`
	)
	out.push(`${verdicts.join(" · ")} · [Full report: video, stills and logs](${url})`)
	out.push(criteriaTable(main))
	if (m.notes.length) {
		out.push(m.notes.map((n) => `- ${n}`).join("\n"))
	}
	return `${out.join("\n\n")}\n`
}

/**
 * Writes `<outDir>/report.md`. In place, media are linked where they are (the run
 * folder); `bundle` copies them into `<outDir>/media/` so the folder stands alone.
 */
export const writeReport = Effect.fn("writeReport")(function* (
	pair: RunPair,
	outDir: string,
	o: ReportOptions & { readonly bundle: boolean }
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { manifest, media } = yield* buildReport(pair, o)
	if (o.bundle) {
		yield* fs.makeDirectory(path.join(outDir, "media"), { recursive: true })
		yield* Effect.forEach(media, ([name, src]) => fs.copyFile(src, path.join(outDir, "media", name)), {
			discard: true,
		})
	}
	const href = (name: string) =>
		o.bundle ? `./media/${name}` : `./${path.relative(outDir, media.get(name) ?? path.join(outDir, name))}`
	const file = path.join(outDir, RUN_FILES.report)
	yield* fs.writeFileString(file, reportMarkdown(manifest, href))
	return file
})
