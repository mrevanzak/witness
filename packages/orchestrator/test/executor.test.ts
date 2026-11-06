import { assert, describe, it } from "@effect/vitest"
import { buildTools } from "../src/executor.ts"

describe("buildTools", () => {
	it("defines strict schemas with every property required", () => {
		for (const t of buildTools(true, "desktop")) {
			const s = t.input_schema as unknown as {
				properties: Record<string, unknown>
				required: string[]
				additionalProperties: boolean
			}
			assert.isTrue(t.strict)
			assert.isFalse(s.additionalProperties)
			assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort())
		}
	})
	it("offers type_secret only when a password is configured", () => {
		assert.include(
			buildTools(true, "desktop").map((t) => t.name),
			"type_secret"
		)
		assert.notInclude(
			buildTools(false, "desktop").map((t) => t.name),
			"type_secret"
		)
	})
	it("has no tool that edits code or runs commands", () => {
		const names = buildTools(true, "desktop").map((t) => t.name)
		for (const banned of ["bash", "exec", "shell", "write_file", "edit", "git"]) {
			assert.notInclude(names, banned)
		}
	})
	it("leaves out the browser's console and network logs on a phone", () => {
		const desktop = buildTools(true, "desktop").map((t) => t.name)
		const phone = buildTools(true, "phone").map((t) => t.name)
		assert.includeMembers(desktop, ["console_logs", "network_errors"])
		assert.notInclude(phone, "console_logs")
		assert.notInclude(phone, "network_errors")
		assert.include(phone, "app_logs")
	})
})
