// pnpm --filter @mrevanzak/witness build: assemble the npm package in apps/cli/dist.
//   dist/bin/witness.mjs        the CLI with the @witness/* packages bundled in; npm deps stay external
//   dist/bin/playwright/        the Playwright reporter read next to the bundle at runtime
//   dist/remotion, dist/src     the Remotion composition, bundled by @remotion/bundler on each render
//   dist/computer               the computer image's build context for `witness image`
import { cp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { build } from "esbuild"

const cli = path.resolve(import.meta.dirname, "..")
const root = path.resolve(cli, "../..")
const dist = path.join(cli, "dist")
const pkg = JSON.parse(await readFile(path.join(cli, "package.json"), "utf8")) as {
	dependencies: Record<string, string>
}

await rm(dist, { force: true, recursive: true })

await build({
	bundle: true,
	entryPoints: [path.join(cli, "src/main.ts")],
	external: Object.keys(pkg.dependencies),
	format: "esm",
	logLevel: "warning",
	outfile: path.join(dist, "bin/witness.mjs"),
	platform: "node",
	target: "node22",
})
await cp(
	path.join(root, "packages/orchestrator/src/playwright/reporter.cjs"),
	path.join(dist, "bin/playwright/reporter.cjs")
)

// render.ts renders `../remotion/index.ts` from the bundle's directory; the composition imports ../src/timeline.
await cp(path.join(root, "packages/renderer/remotion"), path.join(dist, "remotion"), {
	filter: (f) => !f.endsWith("tsconfig.json"),
	recursive: true,
})
await cp(path.join(root, "packages/renderer/src/timeline.ts"), path.join(dist, "src/timeline.ts"))

// Same as the root build:control script, written into the shipped build context.
const infra = path.join(root, "infra/computer")
const computer = path.join(dist, "computer")
await Promise.all(
	["Dockerfile", "start.sh", "fluxbox", "control/package.json", "control/package-lock.json"].map((f) =>
		cp(path.join(infra, f), path.join(computer, f), { recursive: true })
	)
)
await build({
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	bundle: true,
	entryPoints: [path.join(root, "packages/computer/src/server/main.ts")],
	external: ["playwright-core"],
	format: "esm",
	logLevel: "warning",
	outfile: path.join(computer, "control/dist/control.mjs"),
	platform: "node",
	target: "node22",
})

console.log(`built ${path.relative(root, dist)}`)
