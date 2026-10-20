// What every report surface says the same way: report.md, the hosted page, the PR
// section and the live view. (The video is a separate bundle and keeps its own copy
// of the palette.)
import type { CriterionKind, CriterionStatus } from "./ids.ts"

export const STATUS_ICON: Record<CriterionStatus, string> = { blocked: "⚠️", fail: "❌", pass: "✅" }
export const STATUS_WORD: Record<CriterionStatus, string> = { blocked: "Blocked", fail: "Fail", pass: "Pass" }

/** `C2 (regression)`, or `C2 · regression` with `sep`. */
export const criterionLabel = (c: { readonly id: string; readonly kind: CriterionKind }, sep = " (regression)") =>
	`${c.id}${c.kind === "regression" ? sep : ""}`

/** Seconds as m:ss. */
export const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`

/** Text that is safe inside one markdown table cell. */
export const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")

/** A report's title: the task's first line, without a heading marker. */
export const reportTitle = (task: string) => (task.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim() || "Verification"

/** Witness's dark neutral palette. */
export const PALETTE = {
	blocked: "#e2a336",
	fail: "#f2555a",
	faint: "#55575c",
	hairline: "#2a2c30",
	ink: "#0e0f10",
	muted: "#8b8984",
	paper: "#e7e5e0",
	pass: "#4cc38a",
	surface: "#17181b",
} as const

/** The palette and type as CSS custom properties, for a page's `:root`. */
export const PALETTE_CSS = `${Object.entries(PALETTE)
	.map(([k, v]) => `--${k}: ${v};`)
	.join(" ")}
		--sans: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;`
