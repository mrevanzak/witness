// Pure timeline math for the polished video: speed ramps, zoom keyframes, cursor
// path, captions, title cards and verdict moments. Source times are seconds into
// raw.mp4; output times are seconds into polished.mp4.

export type StepIn = {
	criterion?: string
	label?: string
	status?: string
	t: number
	to_x?: number
	to_y?: number
	tool: string
	x?: number
	y?: number
}

export type CriterionIn = {
	description: string
	explanation: string
	id: string
	kind: "feature" | "regression"
	screenshot: string | null
	status: "pass" | "fail" | "blocked"
}

export type TimelineOptions = {
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
	endCardSec: 3.5,
	fps: 30,
	freezeSec: 1.4,
	idleSpeed: { max: 8, min: 4 },
	screen: { h: 1080, w: 1920 },
	targetSec: 55,
	zoom: 1.8,
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

export type Timeline = {
	captions: Array<{ start: number; end: number; text: string }>
	cards: Array<{ start: number; end: number; id: string; kind: string; title: string }>
	/** Source times of clicks (ripple). */
	clicks: Array<{ t: number; x: number; y: number }>
	cursor: CursorKey[]
	/** Source-time windows when the cursor is shown. */
	cursorVisible: [number, number][]
	durationInFrames: number
	end: { overall: string; title: string; criteria: Array<{ id: string; status: string; description: string }> }
	fps: number
	marks: Array<{ start: number; end: number; id: string; status: string }>
	/** Short SHA and an optional label ("before"/"after") for the header. */
	meta: { sha: string; label?: string }
	screen: { w: number; h: number }
	segments: Segment[]
	sourceDuration: number
	zoom: ZoomKey[]
}

const POINTER = new Set(["click", "double_click", "right_click", "click_element", "drag", "scroll"])
const FOCUS = new Set(["type", "type_secret", "key"])
const CLICK = new Set(["click", "double_click", "right_click", "click_element"])

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
				pts.push({ t: s.t + 0.3, ...last, tool: "drag_end" })
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
 * Zoom keyframes. Actions closer than `groupGap` seconds (or near each other on
 * screen within `panGap`) share one zoom-in and pan between points; the camera
 * zooms back out ~1.5 s after the last action of a group.
 */
export function zoomKeys(
	points: Array<{ t: number; x: number; y: number }>,
	o: Pick<TimelineOptions, "zoom" | "screen"> = DEFAULTS,
	groupGap = 2.6,
	panGap = 10,
	near = 600
): ZoomKey[] {
	const center = { cx: o.screen.w / 2, cy: o.screen.h / 2 }
	const keys: ZoomKey[] = [{ scale: 1, t: 0, ...center }]
	let i = 0
	while (i < points.length) {
		let j = i
		while (j + 1 < points.length) {
			const a = points[j]!
			const b = points[j + 1]!
			const gap = b.t - a.t
			const dist = Math.hypot(b.x - a.x, b.y - a.y)
			if (gap < groupGap || (gap < panGap && dist < near)) {
				j += 1
			} else {
				break
			}
		}
		const group = points.slice(i, j + 1)
		const first = group[0]!
		const lastKey = keys.at(-1)!
		const zIn = Math.max(first.t - 0.6, lastKey.t + 0.01)
		keys.push({ scale: 1, t: zIn, ...center })
		keys.push({
			scale: o.zoom,
			t: Math.max(first.t - 0.05, zIn + 0.01),
			...clampCenter(first.x, first.y, o.zoom, o.screen),
		})
		for (const p of group.slice(1)) {
			const prev = keys.at(-1)!
			const panStart = Math.max(p.t - 0.5, prev.t + 0.01)
			keys.push({ ...prev, t: panStart })
			keys.push({ scale: o.zoom, t: Math.max(p.t - 0.05, panStart + 0.01), ...clampCenter(p.x, p.y, o.zoom, o.screen) })
		}
		const last = keys.at(-1)!
		const holdEnd = group.at(-1)!.t + 1.4
		keys.push({ ...last, t: Math.max(holdEnd, last.t + 0.01) })
		keys.push({ scale: 1, t: Math.max(holdEnd + 0.6, last.t + 0.02), ...center })
		i = j + 1
	}
	return keys
}

const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

/** Interpolated zoom at source time t (eased between keyframes). */
export function zoomAt(keys: ZoomKey[], t: number): ZoomKey {
	if (keys.length === 0) {
		return { cx: DEFAULTS.screen.w / 2, cy: DEFAULTS.screen.h / 2, scale: 1, t }
	}
	if (t <= keys[0]!.t) {
		return { ...keys[0]!, t }
	}
	for (let k = 0; k < keys.length - 1; k++) {
		const a = keys[k]!
		const b = keys[k + 1]!
		if (t >= a.t && t <= b.t) {
			const u = b.t === a.t ? 1 : easeInOutCubic((t - a.t) / (b.t - a.t))
			return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, scale: a.scale + (b.scale - a.scale) * u, t }
		}
	}
	return { ...keys.at(-1)!, t }
}

/** Cursor position at source t: eased glide into each point over the 0.45 s before it. */
export function cursorAt(keys: CursorKey[], t: number): { x: number; y: number } | null {
	if (keys.length === 0) {
		return null
	}
	if (t <= keys[0]!.t) {
		return { x: keys[0]!.x, y: keys[0]!.y }
	}
	for (let k = 0; k < keys.length - 1; k++) {
		const a = keys[k]!
		const b = keys[k + 1]!
		if (t >= a.t && t <= b.t) {
			const start = Math.max(a.t, b.t - 0.45)
			if (t <= start) {
				return { x: a.x, y: a.y }
			}
			const u = easeInOutCubic((t - start) / (b.t - start))
			return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
		}
	}
	const last = keys.at(-1)!
	return { x: last.x, y: last.y }
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
		if (p.fast && p.srcEnd - p.srcStart < 2) {
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
		cap = Math.max(0.3, budget / idle.length)
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

export function buildTimeline(input: {
	steps: StepIn[]
	criteria: CriterionIn[]
	overall: string
	title: string
	sourceDuration: number
	meta?: { sha: string; label?: string }
	options?: Partial<TimelineOptions>
}): Timeline {
	const o = { ...DEFAULTS, ...input.options }
	const steps = [...input.steps].filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t)
	const dur = input.sourceDuration
	const pts = focusPoints(steps, o.screen)
	const zoom = zoomKeys(pts, o)
	const byId = new Map(input.criteria.map((c) => [c.id, c]))

	// Active (real-time) windows: around every action, criterion boundary, and the opening second.
	const active: [number, number][] = [[0, 1.2]]
	for (const s of steps) {
		if (POINTER.has(s.tool) || FOCUS.has(s.tool) || s.tool === "navigate") {
			active.push([s.t - 0.8, s.t + 1.6])
		} else if (s.tool === "begin_criterion") {
			active.push([s.t - 0.2, s.t + 1.6])
		} else if (s.tool === "end_criterion") {
			active.push([s.t - 0.4, s.t + 1.2])
		}
	}
	// Keep zoom transitions at 1x so they never jump.
	for (let k = 1; k < zoom.length; k++) {
		if (zoom[k]!.scale !== zoom[k - 1]!.scale) {
			active.push([zoom[k - 1]!.t, zoom[k]!.t])
		}
	}

	const fails = steps.filter(
		(s) => s.tool === "end_criterion" && s.status === "fail" && byId.get(s.criterion ?? "")?.status === "fail"
	)
	const extra = fails.length * o.freezeSec + o.endCardSec
	const paced = pace(dur, active, extra, o)

	// Lay out segments in output frames, inserting a freeze right after each failing end_criterion.
	const segments: Segment[] = []
	let frame = 0
	const f = (sec: number) => Math.max(1, Math.round(sec * o.fps))
	const pendingFreezes = [...fails]
	const pushVideo = (srcStart: number, srcEnd: number, rate: number, fast: boolean) => {
		if (srcEnd - srcStart <= 1e-6) {
			return
		}
		const frames = f((srcEnd - srcStart) / rate)
		segments.push({ fast, frames, from: frame, kind: "video", rate, srcEnd, srcStart })
		frame += frames
	}
	for (const p of paced) {
		let start = p.srcStart
		while (pendingFreezes.length && pendingFreezes[0]!.t >= start && pendingFreezes[0]!.t < p.srcEnd) {
			const fz = pendingFreezes.shift()!
			pushVideo(start, fz.t, p.rate, p.fast)
			const c = byId.get(fz.criterion!)!
			const frames = f(o.freezeSec)
			segments.push({
				criterion: c.id,
				explanation: c.explanation,
				frames,
				from: frame,
				image: c.screenshot,
				kind: "freeze",
				srcAt: fz.t,
			})
			frame += frames
			start = fz.t
		}
		pushVideo(start, p.srcEnd, p.rate, p.fast)
	}
	for (const fz of pendingFreezes) {
		const c = byId.get(fz.criterion!)!
		const frames = f(o.freezeSec)
		segments.push({
			criterion: c.id,
			explanation: c.explanation,
			frames,
			from: frame,
			image: c.screenshot,
			kind: "freeze",
			srcAt: Math.min(fz.t, dur),
		})
		frame += frames
	}
	const endFrames = f(o.endCardSec)
	segments.push({ frames: endFrames, from: frame, kind: "end" })
	frame += endFrames

	// Cursor: glides between focus points; visible from 0.8 s before an action until 2 s after.
	const cursor: CursorKey[] = pts.map((p) => ({ t: p.t, x: p.x, y: p.y }))
	const cursorVisible = mergeWindows(pts.map((p) => [p.t - 0.8, p.t + 2.0] as [number, number]))
	const clicks = steps
		.filter((s) => CLICK.has(s.tool) && s.x != null && s.y != null)
		.map((s) => ({ t: s.t, x: s.x!, y: s.y! }))

	const labelled = steps.filter(
		(s) =>
			s.label &&
			(POINTER.has(s.tool) || FOCUS.has(s.tool) || s.tool === "navigate" || s.tool === "wait" || s.tool === "step")
	)
	const captions = labelled.map((s, k) => {
		const next = labelled[k + 1]?.t ?? Number.POSITIVE_INFINITY
		return { end: Math.min(next - 0.3, s.t + 2.6), start: Math.max(0, s.t - 0.3), text: s.label! }
	})

	const cards = steps
		.filter((s) => s.tool === "begin_criterion" && s.criterion && byId.has(s.criterion))
		.map((s) => {
			const c = byId.get(s.criterion!)!
			return { end: s.t + 1.5, id: c.id, kind: c.kind, start: s.t, title: c.description }
		})
	const marks = steps
		.filter((s) => s.tool === "end_criterion" && s.criterion && byId.has(s.criterion))
		.map((s) => ({ end: s.t + 1.2, id: s.criterion!, start: s.t, status: byId.get(s.criterion!)!.status }))

	return {
		captions,
		cards,
		clicks,
		cursor,
		cursorVisible,
		durationInFrames: frame,
		end: {
			criteria: input.criteria.map((c) => ({ description: c.description, id: c.id, status: c.status })),
			overall: input.overall,
			title: input.title,
		},
		fps: o.fps,
		marks,
		meta: input.meta ?? { sha: "" },
		screen: o.screen,
		segments,
		sourceDuration: dur,
		zoom,
	}
}

/** Source time shown at an output frame (null on freeze/end frames). */
export function sourceTimeAt(tl: Timeline, frame: number): { t: number | null; segment: Segment } {
	const seg = tl.segments.find((s) => frame >= s.from && frame < s.from + s.frames) ?? tl.segments.at(-1)!
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
