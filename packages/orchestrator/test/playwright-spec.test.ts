import { describe, expect, it } from "vitest"
import { actionTool, specOutcome, specStatus } from "../src/playwright-spec.ts"

describe("actionTool", () => {
	it("maps Playwright action titles to step tools", () => {
		expect(actionTool("Click getByRole('button', { name: 'Add todo' })")).toBe("click")
		expect(actionTool("Double click getByText('Row')")).toBe("double_click")
		expect(actionTool("Check getByLabel('Done')")).toBe("click")
		expect(actionTool("Fill \"Buy bread\" getByPlaceholder('What needs doing?')")).toBe("type")
		expect(actionTool('Press "Enter"')).toBe("key")
		expect(actionTool('Navigate to "/"')).toBe("navigate")
		expect(actionTool("Mouse wheel")).toBe("scroll")
	})
	it("skips calls that do nothing visible", () => {
		expect(actionTool("Launch browser")).toBeUndefined()
		expect(actionTool("Screenshot")).toBeUndefined()
		expect(actionTool("Evaluate")).toBeUndefined()
	})
})

describe("specStatus", () => {
	it("passes expected and flaky outcomes", () => {
		expect(specStatus("expected", "passed")).toBe("pass")
		expect(specStatus("expected", "failed")).toBe("pass") // test.fail() that failed as declared
		expect(specStatus("flaky", "passed")).toBe("pass")
	})
	it("fails unexpected failures and timeouts", () => {
		expect(specStatus("unexpected", "failed")).toBe("fail")
		expect(specStatus("unexpected", "timedOut")).toBe("fail")
	})
	it("blocks skipped and interrupted tests", () => {
		expect(specStatus("skipped", "skipped")).toBe("blocked")
		expect(specStatus("unexpected", "interrupted")).toBe("blocked")
	})
})

describe("specOutcome", () => {
	const events = [
		{ total: 2, type: "begin" as const },
		{ at: 1000, id: "t1", tags: [], title: "Empty titles are rejected", type: "test" as const },
		{ at: 1100, category: "test.step", id: "t1", title: "Submit with an empty title", type: "step" as const },
		{ at: 1200, category: "pw:api", id: "t1", parent: "s", title: "Click getByRole('button')", type: "step" as const },
		{ at: 1500, category: "test.attach", id: "t1", title: 'Attach "The error"', type: "step" as const },
		{
			annotations: [{ description: "secret is hunter22", type: "note" }],
			at: 2000,
			attachments: [
				{ file: "a/1-the-error.png", name: "The error" },
				{ file: "a/shot.png", name: "screenshot" },
			],
			error: "Expected 'Title is required'\nReceived ''",
			id: "t1",
			outcome: "unexpected" as const,
			points: [{ at: 1210, x: 100, y: 50 }],
			status: "failed" as const,
			type: "end" as const,
		},
		{ at: 3000, id: "t2", tags: ["@regression"], title: "Adding still works @regression", type: "test" as const },
	]
	const out = specOutcome(events, { x: 0, y: 80 }, ["hunter22"])

	it("makes each test a criterion, failing unexpected failures and blocking unfinished ones", () => {
		expect(
			out.records.map((r) => [r.criterion.id, r.criterion.kind, r.criterion.description, r.status, r.forced])
		).toEqual([
			["C1", "feature", "Empty titles are rejected", "fail", undefined],
			["C2", "regression", "Adding still works", "blocked", "spec"],
		])
		expect(out.records[0]!.notes).toBe("Expected 'Title is required' Received ''")
	})
	it("captions with step titles and places clicks from the trace, shifted onto the screen", () => {
		expect(out.steps.find((s) => s.tool === "step")?.label).toBe("Submit with an empty title")
		expect(out.steps.find((s) => s.tool === "click")).toMatchObject({ x: 100, y: 130 })
	})
	it("turns attachments into stills and the final screenshot, and masks secrets in notes", () => {
		expect(out.stills.map((s) => [s.file, s.caption, s.at])).toEqual([["stills/01-the-error.png", "The error", 1500]])
		expect(out.attachments).toEqual([
			{ file: "stills/01-the-error.png", source: "a/1-the-error.png" },
			{ file: "c1-fail.png", source: "a/shot.png" },
		])
		expect(out.notes).toEqual(["secret is [redacted]"])
	})
})
