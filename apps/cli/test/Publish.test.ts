import { describe, expect, it } from "vitest";
import { END, START, placeSection, referencedMedia } from "../src/Publish.ts";

describe("placeSection", () => {
	it("inserts above a bot footer", () => {
		const out = placeSection("Body\n\n🤖 Generated with [Claude Code](x)\n", "## Manual verification\nok");
		expect(out).toBe(`Body\n\n${START}\n## Manual verification\nok\n${END}\n\n🤖 Generated with [Claude Code](x)\n`);
	});
	it("replaces the previous section on re-runs and keeps the rest", () => {
		const first = placeSection("Body", "v1");
		const second = placeSection(`${first}\n<!-- codesmith:footer -->\nx`, "v2 $& $1");
		expect(second).toContain(`${START}\nv2 $& $1\n${END}`);
		expect(second).not.toContain("v1");
		expect(second).toContain("<!-- codesmith:footer -->");
	});
	it("appends when there is no footer", () => {
		expect(placeSection("Body", "s")).toBe(`Body\n\n${START}\ns\n${END}\n`);
	});
});

describe("referencedMedia", () => {
	it("finds ./media references once, in order", () => {
		expect(referencedMedia("![a](./stills/01-a.png) x ./polished.mp4\n![b](./stills/01-a.png) ./b.jpg ./notes.md")).toEqual(["./stills/01-a.png", "./polished.mp4", "./b.jpg"]);
	});
});
