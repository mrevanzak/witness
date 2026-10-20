import { describe, expect, it } from "vitest"
import { actionTool, specStatus } from "../src/playwright-spec.ts"

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
