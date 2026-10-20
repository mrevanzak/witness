import { describe, expect, it } from "vitest";
import { buildTimeline, clampCenter, cursorAt, focusPoints, mergeWindows, outputTimeOf, pace, sourceTimeAt, zoomAt, zoomKeys, DEFAULTS, type StepIn } from "../src/timeline.ts";

const screen = DEFAULTS.screen;

describe("clampCenter", () => {
	it("keeps the zoomed viewport inside the frame", () => {
		expect(clampCenter(0, 0, 2)).toEqual({ cx: 480, cy: 270 });
		expect(clampCenter(1920, 1080, 2)).toEqual({ cx: 1440, cy: 810 });
		expect(clampCenter(960, 540, 2)).toEqual({ cx: 960, cy: 540 });
	});
});

describe("focusPoints", () => {
	it("uses the last pointer position for typing and ignores non-visual tools", () => {
		const steps: StepIn[] = [
			{ t: 1, tool: "type", label: "too early" },
			{ t: 2, tool: "click", x: 100, y: 200 },
			{ t: 3, tool: "page_snapshot" },
			{ t: 4, tool: "type", label: "x" },
		];
		expect(focusPoints(steps)).toEqual([
			{ t: 2, x: 100, y: 200, tool: "click" },
			{ t: 4, x: 100, y: 200, tool: "type" },
		]);
	});
});

describe("zoomKeys / zoomAt", () => {
	it("zooms in before an action, holds, and zooms out ~1.5 s after", () => {
		const keys = zoomKeys([{ t: 5, x: 900, y: 500 }]);
		expect(zoomAt(keys, 4).scale).toBe(1);
		expect(zoomAt(keys, 5).scale).toBeCloseTo(1.8);
		expect(zoomAt(keys, 5).cx).toBeCloseTo(900);
		expect(zoomAt(keys, 6.3).scale).toBeCloseTo(1.8);
		expect(zoomAt(keys, 7.1).scale).toBe(1);
	});

	it("pans within a group instead of zooming out between nearby actions", () => {
		const keys = zoomKeys([
			{ t: 5, x: 900, y: 500 },
			{ t: 6, x: 1000, y: 520 },
		]);
		for (let t = 5; t <= 6; t += 0.1) expect(zoomAt(keys, t).scale).toBeCloseTo(1.8);
		expect(zoomAt(keys, 6).cx).toBeCloseTo(1000);
	});

	it("zooms out between far-apart, distant-in-time actions", () => {
		const keys = zoomKeys([
			{ t: 5, x: 100, y: 100 },
			{ t: 20, x: 1800, y: 1000 },
		]);
		expect(zoomAt(keys, 12).scale).toBe(1);
	});

	it("clamps every zoomed centre", () => {
		for (const k of zoomKeys([{ t: 2, x: 0, y: 0 }, { t: 3, x: 1920, y: 1080 }])) {
			if (k.scale > 1) {
				expect(k.cx).toBeGreaterThanOrEqual(screen.w / (2 * k.scale) - 1e-9);
				expect(k.cy).toBeLessThanOrEqual(screen.h - screen.h / (2 * k.scale) + 1e-9);
			}
		}
	});

	it("keyframe times never go backwards", () => {
		const keys = zoomKeys([{ t: 0.1, x: 1, y: 1 }, { t: 0.2, x: 5, y: 5 }, { t: 0.25, x: 9, y: 9 }, { t: 9, x: 1000, y: 900 }]);
		for (let k = 1; k < keys.length; k++) expect(keys[k]!.t).toBeGreaterThan(keys[k - 1]!.t);
	});
});

describe("cursorAt", () => {
	it("rests on a point, then glides to the next over the last 0.45 s", () => {
		const keys = [{ t: 1, x: 0, y: 0 }, { t: 5, x: 100, y: 0 }];
		expect(cursorAt(keys, 3)).toEqual({ x: 0, y: 0 });
		expect(cursorAt(keys, 5)).toEqual({ x: 100, y: 0 });
		const mid = cursorAt(keys, 4.775)!;
		expect(mid.x).toBeGreaterThan(0);
		expect(mid.x).toBeLessThan(100);
	});
});

describe("pace", () => {
	it("keeps active windows at 1x and fast-forwards idle stretches 4-8x", () => {
		const parts = pace(60, [[0, 5], [30, 35]], 4, { targetSec: 55, idleSpeed: { min: 4, max: 8 } });
		expect(parts.filter((p) => !p.fast).every((p) => p.rate === 1)).toBe(true);
		for (const p of parts.filter((x) => x.fast)) expect(p.rate).toBeGreaterThanOrEqual(4);
	});

	it("caps idle stretches when even 8x would exceed the target", () => {
		const active = Array.from({ length: 20 }, (_, i) => [i * 30, i * 30 + 2] as [number, number]);
		const parts = pace(600, active, 5, { targetSec: 55, idleSpeed: { min: 4, max: 8 } });
		const out = parts.reduce((n, p) => n + (p.srcEnd - p.srcStart) / p.rate, 0);
		expect(out).toBeLessThanOrEqual(55);
	});

	it("does not speed up short gaps", () => {
		const parts = pace(10, [[0, 4], [5.5, 10]], 0, { targetSec: 55, idleSpeed: { min: 4, max: 8 } });
		expect(parts.every((p) => p.rate === 1)).toBe(true);
	});

	it("merges overlapping windows", () => {
		expect(mergeWindows([[3, 5], [0, 2], [1, 4], [8, 7]])).toEqual([[0, 5]]);
	});
});

describe("buildTimeline", () => {
	// A long, realistic run: model latency makes ~8 s gaps between actions.
	const steps: StepIn[] = [{ t: 1, tool: "begin_criterion", criterion: "C1" }];
	let t = 2;
	for (let i = 0; i < 8; i++, t += 8) steps.push({ t, tool: "click", x: 800 + i * 10, y: 400, label: `Step ${i}`, criterion: "C1" });
	steps.push({ t, tool: "end_criterion", criterion: "C1", status: "fail" });
	steps.push({ t: t + 2, tool: "begin_criterion", criterion: "C2" });
	for (let i = 0; i < 6; i++) steps.push({ t: t + 4 + i * 9, tool: "click", x: 300, y: 900, label: `Other ${i}`, criterion: "C2" });
	const last = t + 4 + 5 * 9 + 3;
	steps.push({ t: last, tool: "end_criterion", criterion: "C2", status: "pass" });
	const tl = buildTimeline({
		steps,
		criteria: [
			{ id: "C1", kind: "feature", description: "Empty title shows an error", status: "fail", explanation: "No error shown.", screenshot: "c1-fail.png" },
			{ id: "C2", kind: "regression", description: "Normal todo works", status: "pass", explanation: "Added.", screenshot: "c2-pass.png" },
		],
		overall: "fail",
		title: "Validate empty todo titles",
		sourceDuration: last + 3,
	});

	it("fits a 2-minute run under 60 s", () => {
		expect(tl.sourceDuration).toBeGreaterThan(110);
		expect(tl.durationInFrames / tl.fps).toBeLessThan(60);
	});

	it("has contiguous segments ending with the end card", () => {
		let f = 0;
		for (const s of tl.segments) {
			expect(s.from).toBe(f);
			f += s.frames;
		}
		expect(f).toBe(tl.durationInFrames);
		expect(tl.segments.at(-1)!.kind).toBe("end");
	});

	it("freezes once on the failing criterion with its screenshot", () => {
		const freezes = tl.segments.filter((s) => s.kind === "freeze");
		expect(freezes).toHaveLength(1);
		expect(freezes[0]).toMatchObject({ criterion: "C1", image: "c1-fail.png", explanation: "No error shown." });
	});

	it("shows every click at real speed, zoomed in", () => {
		for (const s of steps.filter((x) => x.tool === "click")) {
			const out = outputTimeOf(tl, s.t)!;
			const { t: src, segment } = sourceTimeAt(tl, Math.floor(out * tl.fps));
			expect(segment.kind).toBe("video");
			expect(segment.kind === "video" && segment.rate).toBe(1);
			expect(Math.abs(src! - s.t)).toBeLessThan(0.05);
			expect(zoomAt(tl.zoom, s.t).scale).toBeCloseTo(1.8, 1);
		}
	});

	it("adds a title card per criterion and a caption per labelled action", () => {
		expect(tl.cards.map((c) => c.id)).toEqual(["C1", "C2"]);
		expect(tl.captions).toHaveLength(14);
		for (const c of tl.captions) expect(c.end).toBeGreaterThan(c.start);
	});
});
