import { describe, expect, it } from "vitest";
import { buildTools } from "../src/execute.ts";

describe("buildTools", () => {
	it("defines strict schemas with every property required", () => {
		for (const t of buildTools(true)) {
			const s = t.input_schema as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
			expect(t.strict).toBe(true);
			expect(s.additionalProperties).toBe(false);
			expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
		}
	});
	it("offers type_secret only when a password is configured", () => {
		expect(buildTools(true).map((t) => t.name)).toContain("type_secret");
		expect(buildTools(false).map((t) => t.name)).not.toContain("type_secret");
	});
	it("has no tool that edits code or runs commands", () => {
		const names = buildTools(true).map((t) => t.name);
		for (const banned of ["bash", "exec", "shell", "write_file", "edit", "git"]) expect(names).not.toContain(banned);
	});
});
