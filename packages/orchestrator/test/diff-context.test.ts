import { describe, expect, it } from "vitest"
import { fitDiff, splitDiff } from "../src/diff-context.ts"

const file = (path: string, lines: number, sign = "+") =>
	`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `${sign}line ${i} of ${path}`).join("\n")}\n`

describe("splitDiff", () => {
	it("splits per file and counts lines", () => {
		const d = file("a.js", 3) + file("b.js", 2, "-")
		const files = splitDiff(d)
		expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
			["a.js", 3, 0],
			["b.js", 0, 2],
		])
	})
})

describe("fitDiff", () => {
	it("returns small diffs unchanged", () => {
		const d = file("src/app.js", 10)
		expect(fitDiff(d)).toMatchObject({ text: d, truncated: false })
	})

	it("summarises lockfiles and generated files even when small", () => {
		const d = file("src/app.js", 5) + file("pnpm-lock.yaml", 5) + file("dist/app.min.js", 5)
		const r = fitDiff(d)
		expect(r.truncated).toBe(true)
		expect(r.text).toContain("line 0 of src/app.js")
		expect(r.text).not.toContain("line 0 of pnpm-lock.yaml")
		expect(r.text).toContain("pnpm-lock.yaml: +5 -0 (lockfile)")
		expect(r.text).toContain("dist/app.min.js: +5 -0 (generated)")
	})

	it("keeps small files whole, cuts big ones, and stays within budget", () => {
		const d = file("small.js", 5) + file("big.js", 3000) + file("huge.js", 9000)
		const r = fitDiff(d, 20_000, 2000)
		expect(r.text.length).toBeLessThanOrEqual(20_000 + 500)
		const mode = Object.fromEntries(r.files.map((f) => [f.path, f.included]))
		expect(mode["small.js"]).toBe("full")
		expect(["head", "summary"]).toContain(mode["huge.js"])
		expect(r.text).toContain("huge.js")
		expect(r.text).toContain("big.js")
	})
})
