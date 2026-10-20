// Pure timeline math for the polished video: speed ramps, zoom keyframes, cursor
// path, captions, freezes on failing checks and each criterion's check window,
// plus the layouts the driver (render.ts) and the composition (polished.tsx) share.
// Source times are seconds into raw.mp4; output times are seconds into polished.mp4.
// Type-only imports: this file is bundled into the Remotion composition.
import type { CriterionStatus, EvidenceDestination, Step, StepTool, VerdictCriterion } from "@witness/domain"

/** A recorded step that has a video time. */
export type StepIn = Pick<Step, "criterion" | "label" | "status" | "to_x" | "to_y" | "tool" | "x" | "y"> & {
	readonly t: number
}

export type CriterionIn = Pick<VerdictCriterion, "description" | "explanation" | "id" | "status"> & {
	readonly screenshot: string | null
}

export type TimelineOptions = {
	/** Camera zoom/pan, the cursor and click ripples; off, the recording plays as captured. */
	animate: boolean
	endCardSec: number
	fps: number
	freezeSec: number
	idleSpeed: { min: number; max: number }
	/** Recorded screen size (zoom/cursor coordinates). */
	screen: { w: number; h: number }
	targetSec: number
	zoom: number
}

export const DEFAULTS: TimelineOptions = {
	animate: true,
	endCardSec: 3.5,
	fps: 30,
	freezeSec: 1.4,
	idleSpeed: { max: 8, min: 4 },
	screen: { h: 1080, w: 1920 },
	targetSec: 55,
	zoom: 1.8,
}

/** The timings the pacing is built from, in seconds (`near` is screen px). */
export const PACING = {
	/** Real-time (1x) windows, [before, after] a step. */
	active: {
		action: [0.8, 1.6],
		begin: [0.2, 1.6],
		end: [0.4, 1.2],
		/** The opening stretch, from 0. */
		opening: 1.2,
	},
	/** A label is captioned from `lead` before its step for up to `hold`, until the next caption starts. */
	caption: { hold: 2.6, lead: 0.3 },
	cursor: {
		/** A drag's end point follows its start. */
		dragEnd: 0.3,
		/** Eased glide into each point; a click's ripple expands over the same time. */
		glide: 0.45,
		/** Shown from [0] before an action until [1] after it. */
		show: [0.8, 2.0],
	},
	idle: {
		/** Floor on a capped idle stretch's output length. */
		minCap: 0.3,
		/** Idle gaps shorter than this play at 1x. */
		minGap: 2,
	},
	zoom: {
		/** Arrive on an action this long before it. */
		arrive: 0.05,
		/** Actions closer than this share one zoom-in; the camera pans between them. */
		groupGap: 2.6,
		/** Hold after a group's last action, then zoom out over `out`. */
		hold: 1.4,
		/** Zoom in over this lead before a group's first action. */
		lead: 0.6,
		/** Actions within this many px of each other also share a zoom when less than `panGap` apart. */
		near: 600,
		out: 0.6,
		/** Pan to each next action over this lead. */
		pan: 0.5,
		panGap: 10,
	},
} as const

/**
 * How the video is framed for where it is published. `pr`: the app beside the
 * criteria rail, with captions, tape and a verdict card burned in (it plays
 * alone in the PR). `hosted`: the app fills the frame; the report page shows the
 * criteria and verdict, and captions ship as captions.vtt.
 */
export type Layout = EvidenceDestination

export type LayoutSpec = {
	/** Burned into the frame, or written to captions.vtt for the page to toggle. */
	readonly captions: "burned" | "vtt"
	/** Header, criteria rail, timecode and evidence tape around the app. */
	readonly chrome: boolean
	/** Verdict card at the end (0: none, the page shows the verdict). */
	readonly endCardSec: number
	/** Where the app sits in the 1920x1080 composition. */
	readonly frame: {
		readonly x: number
		readonly y: number
		readonly w: number
		readonly h: number
		readonly radius: number
	}
	/** `outer`: a hairline frame that turns red on a freeze. `inner`: no frame; a red border drawn inside on a freeze. */
	readonly freezeBorder: "outer" | "inner"
	/** In-frame labels (speed badge, freeze note); the hosted video plays small on the page. */
	readonly labelScale: number
}

export const LAYOUTS: Record<Layout, LayoutSpec> = {
	hosted: {
		captions: "vtt",
		chrome: false,
		endCardSec: 0,
		frame: { h: 1080, radius: 0, w: 1920, x: 0, y: 0 },
		freezeBorder: "inner",
		labelScale: 1.5,
	},
	pr: {
		captions: "burned",
		chrome: true,
		endCardSec: DEFAULTS.endCardSec,
		frame: { h: Math.round((1432 * 9) / 16), radius: 8, w: 1432, x: 440, y: 76 },
		freezeBorder: "outer",
		labelScale: 1,
	},
}

export type Segment =
	| { kind: "video"; from: number; frames: number; srcStart: number; srcEnd: number; rate: number; fast: boolean }
	| {
			kind: "freeze"
			from: number
			frames: number
			srcAt: number
			criterion: string
			image: string | null
			explanation: string
	  }
	| { kind: "end"; from: number; frames: number }

export type ZoomKey = {
	cx: number
	cy: number
	scale: number
	t: number
}

export type CursorKey = {
	t: number
	x: number
	y: number
}

/** A criterion and the source times of its first begin_criterion / end_criterion steps (null without one). */
export type TimelineCriterion = {
	begin: number | null
	description: string
	end: number | null
	id: string
	status: CriterionStatus
}

export type Timeline = {
	captions: Array<{ start: number; end: number; text: string }>
	criteria: TimelineCriterion[]
	/** Source times of clicks (ripple). */
	clicks: Array<{ t: number; x: number; y: number }>
	cursor: CursorKey[]
	/** Source-time windows when the cursor is shown. */
	cursorVisible: [number, number][]
	durationInFrames: number
	fps: number
	/** Short SHA and an optional label ("before"/"after") for the header. */
	meta: { sha: string; label?: string }
	overall: CriterionStatus
	screen: { w: number; h: number }
	segments: Segment[]
	sourceDuration: number
	zoom: ZoomKey[]
}

/** Input props of the Remotion composition (render/props.json). */
export type PolishedProps = {
	layout: Layout
	timeline: Timeline
	title: string
	/** raw.mp4, relative to the public dir (the run dir). */
	video: string
}

const POINTER: ReadonlySet<StepTool> = new Set([
	"click",
	"double_click",
	"right_click",
	"click_element",
	"drag",
	"scroll",
])
const FOCUS: ReadonlySet<StepTool> = new Set(["type", "type_secret", "key"])
const CLICK: ReadonlySet<StepTool> = new Set(["click", "double_click", "right_click", "click_element"])

/** A step the viewer sees happen: pointer actions, typing and navigation. */
export const isVisualStep = (tool: StepTool) => POINTER.has(tool) || FOCUS.has(tool) || tool === "navigate"

/** A click of any kind (it gets a ripple). */
export const isClick = (tool: StepTool) => CLICK.has(tool)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Merges overlapping [a, b] windows. */
export function mergeWindows(ws: [number, number][]): [number, number][] {
	const sorted = ws.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])
	const out: [number, number][] = []
	for (const w of sorted) {
		const last = out.at(-1)
		if (last && w[0] <= last[1]) {
			last[1] = Math.max(last[1], w[1])
		} else {
			out.push([w[0], w[1]])
		}
	}
	return out
}

/** Points the camera and cursor should follow: pointer actions, and typing at the last pointer position. */
export function focusPoints(
	steps: StepIn[],
	screen = DEFAULTS.screen
): Array<{ t: number; x: number; y: number; tool: string }> {
	const pts: Array<{ t: number; x: number; y: number; tool: string }> = []
	let last: { x: number; y: number } | null = null
	for (const s of steps) {
		if (POINTER.has(s.tool) && s.x != null && s.y != null) {
			last = { x: clamp(s.x, 0, screen.w), y: clamp(s.y, 0, screen.h) }
			pts.push({ t: s.t, ...last, tool: s.tool })
			if (s.tool === "drag" && s.to_x != null && s.to_y != null) {
				last = { x: s.to_x, y: s.to_y }
				pts.push({ t: s.t + PACING.cursor.dragEnd, ...last, tool: "drag_end" })
			}
		} else if (FOCUS.has(s.tool) && last) {
			pts.push({ t: s.t, ...last, tool: s.tool })
		}
	}
	return pts
}

/** Clamp a zoom centre so the zoomed viewport stays inside the frame. */
export function clampCenter(
	cx: number,
	cy: number,
	scale: number,
	screen = DEFAULTS.screen
): { cx: number; cy: number } {
	const hw = screen.w / (2 * scale)
	const hh = screen.h / (2 * scale)
	return { cx: clamp(cx, hw, screen.w - hw), cy: clamp(cy, hh, screen.h - hh) }
}

/**
 * Zoom keyframes. Nearby actions (PACING.zoom) share one zoom-in and pan between
 * points; the camera zooms back out after the last action of a group. Each key
 * is nudged at least 0.01 s past the previous so times never go backwards.
 */
export function zoomKeys(
	points: Array<{ t: number; x: number; y: number }>,
	o: Pick<TimelineOptions, "zoom" | "screen"> = DEFAULTS
): ZoomKey[] {
	const P = PACING.zoom
	const center = { cx: o.screen.w / 2, cy: o.screen.h / 2 }
	const keys: ZoomKey[] = [{ scale: 1, t: 0, ...center }]
	const at = (p: { x: number; y: number }) => clampCenter(p.x, p.y, o.zoom, o.screen)
	let i = 0
	while (i < points.length) {
		let j = i
		for (let a = points[j], b = points[j + 1]; a && b; a = b, b = points[j + 1]) {
			const gap = b.t - a.t
			if (!(gap < P.groupGap || (gap < P.panGap && Math.hypot(b.x - a.x, b.y - a.y) < P.near))) {
				break
			}
			j += 1
		}
		const [first, ...rest] = points.slice(i, j + 1)
		if (!first) {
			break
		}
		const zIn = Math.max(first.t - P.lead, (keys.at(-1)?.t ?? 0) + 0.01)
		keys.push({ scale: 1, t: zIn, ...center })
		let last: ZoomKey = { scale: o.zoom, t: Math.max(first.t - P.arrive, zIn + 0.01), ...at(first) }
		keys.push(last)
		for (const p of rest) {
			const panStart = Math.max(p.t - P.pan, last.t + 0.01)
			keys.push({ ...last, t: panStart })
			last = { scale: o.zoom, t: Math.max(p.t - P.arrive, panStart + 0.01), ...at(p) }
			keys.push(last)
		}
		const holdEnd = (rest.at(-1) ?? first).t + P.hold
		keys.push({ ...last, t: Math.max(holdEnd, last.t + 0.01) })
		keys.push({ scale: 1, t: Math.max(holdEnd + P.out, last.t + 0.02), ...center })
		i = j + 1
	}
	return keys
}

const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

/** The keyframes either side of t, or the edge key when t is outside them. */
const around = <K extends { t: number }>(keys: K[], t: number): { a: K; b: K } | { edge: K } | null => {
	const [head] = keys
	if (!head) {
		return null
	}
	if (t <= head.t) {
		return { edge: head }
	}
	for (let k = 0; k < keys.length - 1; k++) {
		const a = keys[k]
		const b = keys[k + 1]
		if (a && b && t >= a.t && t <= b.t) {
			return { a, b }
		}
	}
	return { edge: keys.at(-1) ?? head }
}

/** Interpolated zoom at source time t (eased between keyframes). */
export function zoomAt(keys: ZoomKey[], t: number): ZoomKey {
	const span = around(keys, t)
	if (!span) {
		return { cx: DEFAULTS.screen.w / 2, cy: DEFAULTS.screen.h / 2, scale: 1, t }
	}
	if ("edge" in span) {
		return { ...span.edge, t }
	}
	const { a, b } = span
	const u = b.t === a.t ? 1 : easeInOutCubic((t - a.t) / (b.t - a.t))
	return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, scale: a.scale + (b.scale - a.scale) * u, t }
}

/** Cursor position at source t: an eased glide into each point over the PACING.cursor.glide before it. */
export function cursorAt(keys: CursorKey[], t: number): { x: number; y: number } | null {
	const span = around(keys, t)
	if (!span) {
		return null
	}
	if ("edge" in span) {
		return { x: span.edge.x, y: span.edge.y }
	}
	const { a, b } = span
	const start = Math.max(a.t, b.t - PACING.cursor.glide)
	if (t <= start) {
		return { x: a.x, y: a.y }
	}
	const u = easeInOutCubic((t - start) / (b.t - start))
	return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}

/**
 * Splits the source into active (1x) and idle (fast-forward) stretches. Idle runs
 * at 4-8x; if the result is still longer than the target, each idle stretch is
 * capped to a short output duration (the badge shows the real factor).
 */
export function pace(
	sourceDuration: number,
	active: [number, number][],
	extraSec: number,
	o: Pick<TimelineOptions, "targetSec" | "idleSpeed">
): Array<{ srcStart: number; srcEnd: number; rate: number; fast: boolean }> {
	const act = mergeWindows(
		active.map(([a, b]) => [clamp(a, 0, sourceDuration), clamp(b, 0, sourceDuration)] as [number, number])
	)
	const parts: Array<{ srcStart: number; srcEnd: number; fast: boolean }> = []
	let cur = 0
	for (const [a, b] of act) {
		if (a > cur) {
			parts.push({ fast: true, srcEnd: a, srcStart: cur })
		}
		parts.push({ fast: false, srcEnd: b, srcStart: a })
		cur = b
	}
	if (cur < sourceDuration) {
		parts.push({ fast: true, srcEnd: sourceDuration, srcStart: cur })
	}

	// Short idle gaps are not worth a speed change.
	for (const p of parts) {
		if (p.fast && p.srcEnd - p.srcStart < PACING.idle.minGap) {
			p.fast = false
		}
	}

	const activeLen = parts.filter((p) => !p.fast).reduce((n, p) => n + p.srcEnd - p.srcStart, 0)
	const idle = parts.filter((p) => p.fast)
	const idleLen = idle.reduce((n, p) => n + p.srcEnd - p.srcStart, 0)
	const budget = Math.max(0, o.targetSec - extraSec - activeLen)
	const speed = idleLen > 0 ? clamp(idleLen / Math.max(budget, 0.001), o.idleSpeed.min, o.idleSpeed.max) : 1
	let cap = Number.POSITIVE_INFINITY
	if (idleLen / speed > budget && idle.length > 0) {
		cap = Math.max(PACING.idle.minCap, budget / idle.length)
	}
	return parts.map((p) => {
		if (!p.fast) {
			return { ...p, rate: 1 }
		}
		const len = p.srcEnd - p.srcStart
		const out = Math.min(len / speed, cap)
		return { ...p, rate: Math.max(speed, len / out) }
	})
}

/** Real-time window [before, after] around a step, if it gets one. */
const activeWindow = (tool: StepTool): readonly [number, number] | null => {
	if (isVisualStep(tool)) {
		return PACING.active.action
	}
	if (tool === "begin_criterion") {
		return PACING.active.begin
	}
	return tool === "end_criterion" ? PACING.active.end : null
}

export function buildTimeline(input: {
	steps: StepIn[]
	criteria: CriterionIn[]
	overall: CriterionStatus
	sourceDuration: number
	meta?: { sha: string; label?: string }
	options?: Partial<TimelineOptions>
}): Timeline {
	const o = { ...DEFAULTS, ...input.options }
	const steps = [...input.steps].filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t)
	const dur = input.sourceDuration
	const pts = o.animate ? focusPoints(steps, o.screen) : []
	const zoom = zoomKeys(pts, o)
	const byId = new Map(input.criteria.map((c) => [c.id, c]))

	// Active (real-time) windows: around every action, criterion boundary, and the opening second.
	const active: [number, number][] = [[0, PACING.active.opening]]
	for (const s of steps) {
		const w = activeWindow(s.tool)
		if (w) {
			active.push([s.t - w[0], s.t + w[1]])
		}
	}
	// Keep zoom transitions at 1x so they never jump.
	zoom.forEach((b, k) => {
		const a = zoom[k - 1]
		if (a && b.scale !== a.scale) {
			active.push([a.t, b.t])
		}
	})

	// A failing check freezes on its criterion's screenshot right after its end_criterion.
	const fails = steps.flatMap((s) => {
		const c = s.tool === "end_criterion" && s.status === "fail" ? byId.get(s.criterion ?? "") : undefined
		return c?.status === "fail" ? [{ c, t: s.t }] : []
	})
	const extra = fails.length * o.freezeSec + o.endCardSec
	const paced = pace(dur, active, extra, o)

	// Lay out segments in output frames, inserting a freeze right after each failing end_criterion.
	const segments: Segment[] = []
	let frame = 0
	const f = (sec: number) => Math.max(1, Math.round(sec * o.fps))
	const pushVideo = (srcStart: number, srcEnd: number, rate: number, fast: boolean) => {
		if (srcEnd - srcStart <= 1e-6) {
			return
		}
		const frames = f((srcEnd - srcStart) / rate)
		segments.push({ fast, frames, from: frame, kind: "video", rate, srcEnd, srcStart })
		frame += frames
	}
	const pushFreeze = (c: CriterionIn, srcAt: number) => {
		const frames = f(o.freezeSec)
		segments.push({
			criterion: c.id,
			explanation: c.explanation,
			frames,
			from: frame,
			image: c.screenshot,
			kind: "freeze",
			srcAt,
		})
		frame += frames
	}
	const pending = [...fails]
	/** The next failure, if it falls in [from, to). */
	const takeFail = (from: number, to: number) => {
		const [next] = pending
		return next && next.t >= from && next.t < to ? pending.shift() : undefined
	}
	for (const p of paced) {
		let start = p.srcStart
		for (let fz = takeFail(start, p.srcEnd); fz; fz = takeFail(start, p.srcEnd)) {
			pushVideo(start, fz.t, p.rate, p.fast)
			pushFreeze(fz.c, fz.t)
			start = fz.t
		}
		pushVideo(start, p.srcEnd, p.rate, p.fast)
	}
	for (const fz of pending) {
		pushFreeze(fz.c, Math.min(fz.t, dur))
	}
	if (o.endCardSec > 0) {
		const endFrames = f(o.endCardSec)
		segments.push({ frames: endFrames, from: frame, kind: "end" })
		frame += endFrames
	}

	// Cursor: glides between focus points; visible around each action.
	const { show } = PACING.cursor
	const cursor: CursorKey[] = pts.map((p) => ({ t: p.t, x: p.x, y: p.y }))
	const cursorVisible = mergeWindows(pts.map((p) => [p.t - show[0], p.t + show[1]] as [number, number]))
	const clicks = o.animate
		? steps.flatMap((s) => (isClick(s.tool) && s.x != null && s.y != null ? [{ t: s.t, x: s.x, y: s.y }] : []))
		: []

	const labelled = steps.flatMap((s) =>
		s.label && (isVisualStep(s.tool) || s.tool === "wait" || s.tool === "step") ? [{ t: s.t, text: s.label }] : []
	)
	const { hold, lead } = PACING.caption
	const captions = labelled.map((s, k) => {
		const next = labelled[k + 1]?.t ?? Number.POSITIVE_INFINITY
		return { end: Math.min(next - lead, s.t + hold), start: Math.max(0, s.t - lead), text: s.text }
	})

	const firstT = (tool: string, id: string) => steps.find((s) => s.tool === tool && s.criterion === id)?.t ?? null
	const criteria = input.criteria.map((c) => ({
		begin: firstT("begin_criterion", c.id),
		description: c.description,
		end: firstT("end_criterion", c.id),
		id: c.id,
		status: c.status,
	}))

	return {
		captions,
		clicks,
		criteria,
		cursor,
		cursorVisible,
		durationInFrames: frame,
		fps: o.fps,
		meta: input.meta ?? { sha: "" },
		overall: input.overall,
		screen: o.screen,
		segments,
		sourceDuration: dur,
		zoom,
	}
}

export type CriterionState = TimelineCriterion &
	({ judged: false; state: "pending" | "running" } | { judged: true; state: CriterionStatus })

/** Each criterion at source time t: pending, running from its begin step, then judged (its status) from its end step. */
export function criterionStatesAt(tl: Timeline, t: number): CriterionState[] {
	return tl.criteria.map((c): CriterionState => {
		if (c.end !== null && t >= c.end) {
			return { ...c, judged: true, state: c.status }
		}
		return { ...c, judged: false, state: c.begin !== null && t >= c.begin ? "running" : "pending" }
	})
}

/** Source time shown at an output frame (null on freeze/end frames). */
export function sourceTimeAt(tl: Timeline, frame: number): { t: number | null; segment: Segment } {
	const seg = tl.segments.find((s) => frame >= s.from && frame < s.from + s.frames) ?? tl.segments.at(-1)
	if (!seg) {
		throw new Error("timeline has no segments")
	}
	if (seg.kind === "video") {
		return { segment: seg, t: seg.srcStart + ((frame - seg.from) / tl.fps) * seg.rate }
	}
	if (seg.kind === "freeze") {
		return { segment: seg, t: seg.srcAt }
	}
	return { segment: seg, t: null }
}

/** Output seconds at which a source time is shown (first occurrence), for report links into polished.mp4. */
export function outputTimeOf(tl: Timeline, srcT: number): number | null {
	for (const s of tl.segments) {
		if (s.kind === "video" && srcT >= s.srcStart && srcT <= s.srcEnd) {
			return (s.from + ((srcT - s.srcStart) / s.rate) * tl.fps) / tl.fps
		}
	}
	return null
}

const round1 = (s: number) => Math.round(s * 10) / 10

/**
 * Where each criterion's check is shown in polished.mp4: its [start, end] in raw.mp4
 * as output seconds (0.1 s). Skips criteria without a video range or whose start is
 * cut; an end that is cut collapses onto the start.
 */
export function seekOf(
	tl: Timeline,
	criteria: ReadonlyArray<{ readonly id: string; readonly video_ts: readonly [number, number] | null }>
): Record<string, [number, number]> {
	const seek: Record<string, [number, number]> = {}
	for (const c of criteria) {
		const start = c.video_ts && outputTimeOf(tl, c.video_ts[0])
		if (c.video_ts && start != null) {
			seek[c.id] = [round1(start), round1(outputTimeOf(tl, c.video_ts[1]) ?? start)]
		}
	}
	return seek
}

/** Captions in output seconds, each cut off where its video stretch ends (a freeze or the end card). */
export function captionCues(tl: Timeline): Array<{ start: number; end: number; text: string }> {
	const breaks = tl.segments.filter((s) => s.kind !== "video").map((s) => s.from / tl.fps)
	return tl.captions.flatMap((c) => {
		const start = outputTimeOf(tl, c.start)
		if (start === null) {
			return []
		}
		const cut = breaks.find((b) => b > start) ?? tl.durationInFrames / tl.fps
		const end = Math.min(outputTimeOf(tl, c.end) ?? cut, cut)
		return end > start ? [{ end, start, text: c.text }] : []
	})
}

const vttTime = (s: number) => {
	const ms = Math.round(s * 1000)
	const pad = (n: number, w = 2) => String(n).padStart(w, "0")
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

/** A WebVTT captions track for the hosted video. */
export function webVtt(cues: Array<{ start: number; end: number; text: string }>): string {
	const text = (t: string) =>
		t
			.replace(/\s*\n\s*/g, " ")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/-->/g, "->")
	const body = cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${text(c.text)}`)
	return `WEBVTT\n\n${body.join("\n\n")}\n`
}
