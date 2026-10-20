// The video's palette, type and PR-layout geometry. Same values as the domain
// PALETTE where they overlap; this bundle can only import ../src/timeline.
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono"
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans"
import type { CriterionStatus } from "@witness/domain"
import { LAYOUTS } from "../src/timeline"

export const { fontFamily: SANS } = loadSans("normal", { subsets: ["latin"], weights: ["400", "500", "600"] })
export const { fontFamily: MONO } = loadMono("normal", { subsets: ["latin"], weights: ["400", "500"] })

export const C = {
	blocked: "#E2A336",
	fail: "#F2555A",
	faint: "#4A4C50",
	hairline: "#2A2C30",
	ink: "#0E0F10",
	muted: "#8B8984",
	paper: "#E7E5E0",
	pass: "#4CC38A",
	surface: "#17181B",
}
export const STATUS: Record<CriterionStatus, string> = { blocked: C.blocked, fail: C.fail, pass: C.pass }

// PR chrome (1920x1080) around the app frame: header, criteria rail, caption row, tape.
export const FRAME = LAYOUTS.pr.frame
export const HEADER_Y = 30
export const RAIL_X = 48
export const RAIL_W = 344
export const RIGHT = 1920 - FRAME.x - FRAME.w
export const CAPTION_Y = FRAME.y + FRAME.h + 26
export const TAPE_Y = CAPTION_Y + 74

export const within = (t: number | null, a: number, b: number) => t != null && t >= a && t <= b
export const fade = (t: number, a: number, b: number, f = 0.18) => Math.max(0, Math.min(1, (t - a) / f, (b - t) / f))
export const tc = (s: number) => {
	const m = Math.floor(s / 60)
	return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`
}
