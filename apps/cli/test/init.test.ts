import { parseWitnessConfig } from "@witness/domain"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { composeServices, draftConfig, portInCommand, type RepoFacts, renderDraft, webServerIn } from "../src/init.ts"

const facts = (over: Partial<RepoFacts> = {}): RepoFacts => ({
	compose: {},
	deps: [],
	envExample: {},
	packageManager: "pnpm",
	scripts: {},
	webServer: undefined,
	...over,
})

describe("draftConfig", () => {
	it("uses the dev script and the framework's default port", () => {
		const d = draftConfig(facts({ deps: ["next"], scripts: { build: "next build", dev: "next dev" } }))
		expect(d.config).toMatchObject({
			setup: ["pnpm install --frozen-lockfile"],
			start: "pnpm run dev",
			url: "http://localhost:3000",
		})
	})
	it("prefers Playwright's webServer and its port", () => {
		const d = draftConfig(
			facts({
				deps: ["vite"],
				scripts: { dev: "vite" },
				webServer: { command: "pnpm preview --port 4173", port: undefined, url: "http://localhost:4173" },
			})
		)
		expect(d.config).toMatchObject({ start: "pnpm preview --port 4173", url: "http://localhost:4173" })
	})
	it("reads a port written in the script", () => {
		const d = draftConfig(facts({ packageManager: "npm", scripts: { start: "node server.mjs --port 4000" } }))
		expect(d.config).toMatchObject({ setup: ["npm ci"], start: "npm run start", url: "http://localhost:4000" })
	})
	it("adds compose databases as services and points env at them", () => {
		const d = draftConfig(
			facts({
				compose: {
					db: { env: { POSTGRES_PASSWORD: "pw" }, image: "postgres:16", port: 5432 },
					web: { env: {}, image: "node:22", port: 3000 },
				},
				deps: ["next"],
				envExample: { DATABASE_URL: "postgres://postgres:pw@localhost:5432/app", STRIPE_KEY: "" },
				scripts: { "db:migrate": "prisma migrate deploy", dev: "next dev" },
			})
		)
		expect(d.config.services).toEqual({ db: { env: { POSTGRES_PASSWORD: "pw" }, image: "postgres:16", port: 5432 } })
		expect(d.config.env).toEqual({ DATABASE_URL: "postgres://postgres:pw@db:5432/app", PORT: "3000" })
		expect(d.config.setup).toEqual(["pnpm install --frozen-lockfile", "pnpm run db:migrate"])
		expect(d.notes.join("\n")).toContain("STRIPE_KEY")
	})
	it("always renders a valid witness.yaml, even from an empty repo", async () => {
		for (const f of [
			facts(),
			facts({ packageManager: undefined }),
			facts({ deps: ["vite"], envExample: { A: "1" }, scripts: { dev: "vite" } }),
		]) {
			const text = renderDraft(draftConfig(f))
			await Effect.runPromise(parseWitnessConfig(text))
		}
	})
})

describe("readers", () => {
	it("finds the port in common command forms", () => {
		expect(portInCommand("vite --port 5000")).toBe(5000)
		expect(portInCommand("next dev -p 3100")).toBe(3100)
		expect(portInCommand("PORT=8080 node app.js")).toBe(8080)
		expect(portInCommand("vite")).toBeUndefined()
	})
	it("reads Playwright's webServer", () => {
		const src = `export default defineConfig({ webServer: { command: 'pnpm dev', url: "http://localhost:3000", reuseExistingServer: true } })`
		expect(webServerIn(src)).toEqual({ command: "pnpm dev", port: undefined, url: "http://localhost:3000" })
		expect(webServerIn("export default {}")).toBeUndefined()
	})
	it("reads compose services in list and map env forms", () => {
		const text = `services:\n  db:\n    image: postgres:16\n    ports: ["5433:5432"]\n    environment:\n      - POSTGRES_PASSWORD=pw\n  cache:\n    image: redis:7\n    environment: { A: 1 }\n  app:\n    build: .\n`
		expect(composeServices(text)).toEqual({
			cache: { env: { A: "1" }, image: "redis:7", port: undefined },
			db: { env: { POSTGRES_PASSWORD: "pw" }, image: "postgres:16", port: 5432 },
		})
	})
})
