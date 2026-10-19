import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSteps, StepLog } from "../src/steps.ts";

describe("StepLog", () => {
	it("appends redacted steps and finalizes t relative to t0", () => {
		const p = join(mkdtempSync(join(tmpdir(), "acv-steps-")), "steps.jsonl");
		const log = new StepLog(p, ["hunter2"]);
		log.add({ at: 10_500, tool: "click", x: 1, y: 2, label: "Click" });
		log.add({ at: 14_210, tool: "type", label: "Type hunter2", criterion: "C1" });
		expect(readFileSync(p, "utf8")).not.toContain("hunter2");
		const steps = log.finalize(10_000);
		expect(steps.map((s) => s.t)).toEqual([0.5, 4.21]);
		const back = parseSteps(readFileSync(p, "utf8"));
		expect(back[1]).toMatchObject({ t: 4.21, tool: "type", label: "Type [redacted]", criterion: "C1" });
	});

	it("falls back to the first step when t0 is unknown", () => {
		const log = new StepLog(join(mkdtempSync(join(tmpdir(), "acv-steps-")), "s.jsonl"), []);
		log.add({ at: 5000, tool: "a" });
		log.add({ at: 6500, tool: "b" });
		expect(log.finalize(null).map((s) => s.t)).toEqual([0, 1.5]);
	});
});

describe("parseSteps", () => {
	it("skips blank lines and sorts by time", () => {
		expect(parseSteps('{"at":2,"tool":"b"}\n\n{"at":1,"tool":"a"}\n').map((s) => s.tool)).toEqual(["a", "b"]);
	});
	it("reports the bad line", () => {
		expect(() => parseSteps('{"at":1,"tool":"a"}\nnope')).toThrow(/line 2: invalid JSON/);
		expect(() => parseSteps('{"tool":"a"}')).toThrow(/line 1: needs/);
	});
});
