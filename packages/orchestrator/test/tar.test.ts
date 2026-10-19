import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checksum, chownTar, tarEntries } from "../src/tar.ts";

const QA = { uid: 1000, gid: 1000, user: "qa", group: "qa" };

function gitArchive(): Buffer {
	const dir = mkdtempSync(join(tmpdir(), "acv-tar-"));
	const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir });
	g("init", "-q");
	writeFileSync(join(dir, "a.txt"), "hello\n");
	execFileSync("mkdir", ["-p", join(dir, "sub/deep")]);
	writeFileSync(join(dir, "sub/deep/b.js"), "x".repeat(1500));
	g("add", "-A");
	g("commit", "-qm", "init");
	return execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: dir });
}

describe("chownTar", () => {
	it("rewrites every entry to the target owner with valid checksums", () => {
		const tar = gitArchive();
		expect(tarEntries(tar).filter((e) => e.type !== "g").every((e) => e.uid === 0)).toBe(true);
		const out = chownTar(tar, QA);
		expect(out.length).toBe(tar.length);
		const entries = tarEntries(out);
		expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(["a.txt", "sub/", "sub/deep/", "sub/deep/b.js"]));
		for (const e of entries) expect([e.uid, e.gid]).toEqual([1000, 1000]);
	});

	it("produces an archive that system tar reads and lists as qa", () => {
		const out = chownTar(gitArchive(), QA);
		const listing = execFileSync("tar", ["-tvf", "-"], { input: out }).toString();
		expect(listing).toMatch(/qa\s+qa|1000\s+1000|qa\/qa|1000\/1000/);
		expect(listing).toContain("sub/deep/b.js");
	});

	it("does not mutate its input", () => {
		const tar = gitArchive();
		const copy = Buffer.from(tar);
		chownTar(tar, QA);
		expect(tar.equals(copy)).toBe(true);
	});

	it("rejects a corrupted header", () => {
		const tar = Buffer.from(gitArchive());
		tar[0] = tar[0]! ^ 0xff;
		expect(() => chownTar(tar, QA)).toThrow(/checksum/);
	});

	it("computes the checksum with the field as spaces", () => {
		const h = Buffer.alloc(512);
		expect(checksum(h)).toBe(8 * 0x20);
	});
});
