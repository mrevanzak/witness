import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[], maxBuffer = 512 * 1024 * 1024): Promise<string> {
	const { stdout } = await run("git", args, { cwd, maxBuffer, encoding: "utf8" });
	return stdout;
}

export interface RepoRef {
	/** Repository toplevel. */
	root: string;
	/** Path of the app inside the repo ("" for the root, else "examples/todo-app/"). */
	prefix: string;
	sha: string;
	baseSha: string | null;
}

/** Resolves `ref` (and the diff base) for an app directory that may be a subdirectory of its repo. */
export async function resolveRepo(dir: string, ref: string, base?: string): Promise<RepoRef> {
	const abs = resolve(dir);
	const root = (await git(abs, ["rev-parse", "--show-toplevel"])).trim();
	const prefix = (await git(abs, ["rev-parse", "--show-prefix"])).trim();
	const sha = (await git(abs, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
	let baseSha: string | null = null;
	const candidates = base ? [base] : ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
	for (const c of candidates) {
		try {
			const b = (await git(abs, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`])).trim();
			if (!b) continue;
			baseSha = (await git(abs, ["merge-base", b, sha])).trim();
			if (baseSha === sha && !base) {
				// The ref is on the default branch itself: diff against its parent.
				baseSha = (await git(abs, ["rev-parse", "--verify", "--quiet", `${sha}^`]).catch(() => "")).trim() || null;
			}
			break;
		} catch (e) {
			if (base) throw new Error(`cannot resolve base ${base}: ${(e as Error).message}`);
		}
	}
	return { root, prefix, sha, baseSha };
}

/** `git archive` of the app directory at the exact commit. Never touches the working tree. */
export async function archive(r: RepoRef): Promise<Buffer> {
	const treeish = r.prefix ? `${r.sha}:${r.prefix.replace(/\/$/, "")}` : r.sha;
	const { stdout } = await run("git", ["archive", "--format=tar", treeish], { cwd: r.root, maxBuffer: 2 * 1024 ** 3, encoding: "buffer" });
	return stdout;
}

export async function diff(r: RepoRef): Promise<string> {
	if (!r.baseSha) return "";
	return git(r.root, ["diff", "--no-color", "--find-renames", `${r.baseSha}...${r.sha}`, "--", r.prefix || "."]);
}

export async function changedFiles(r: RepoRef): Promise<Array<{ status: string; path: string }>> {
	if (!r.baseSha) return [];
	const out = await git(r.root, ["diff", "--name-status", "--find-renames", `${r.baseSha}...${r.sha}`, "--", r.prefix || "."]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [status, ...paths] = l.split("\t");
			return { status: status!, path: paths.at(-1)! };
		});
}

export async function fileList(r: RepoRef): Promise<string[]> {
	const out = await git(r.root, ["ls-tree", "-r", "--name-only", r.sha, "--", r.prefix || "."]);
	return out.split("\n").filter(Boolean);
}

export async function showFile(r: RepoRef, path: string): Promise<string | null> {
	try {
		return await git(r.root, ["show", `${r.sha}:${r.prefix}${path}`]);
	} catch {
		return null;
	}
}

export async function commitSubject(r: RepoRef): Promise<string> {
	return (await git(r.root, ["log", "-1", "--format=%s%n%n%b", r.sha])).trim();
}
