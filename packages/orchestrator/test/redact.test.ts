import { describe, expect, it } from "vitest";
import { redact, redactDeep } from "../src/redact.ts";

describe("redact", () => {
	it("masks plain and URL-encoded occurrences", () => {
		expect(redact("pw=s3cr et&x=s3cr%20et s3cr et", ["s3cr et"])).toBe("pw=[redacted]&x=[redacted] [redacted]");
	});
	it("ignores empty secrets", () => {
		expect(redact("abc", [""])).toBe("abc");
	});
	it("redacts nested values but not keys", () => {
		expect(redactDeep({ password: "hunter2", steps: [{ label: "type hunter2" }], n: 3 }, ["hunter2"])).toEqual({
			password: "[redacted]",
			steps: [{ label: "type [redacted]" }],
			n: 3,
		});
	});
});
