import { describe, expect, it } from "vitest";
import { ConfigError, configSecrets, parseVerifyConfig } from "../src/verify-config.ts";

const FULL = `
setup:
  - pnpm install --frozen-lockfile
  - pnpm db:migrate && pnpm db:seed
start: pnpm dev --port 3000
url: http://localhost:3000
health: http://localhost:3000/api/health
services:
  postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: test }, port: 5432 }
env:
  DATABASE_URL: postgres://postgres:test@postgres:5432/postgres
login:
  email: qa@example.com
  password: qa-password
`;

describe("parseVerifyConfig", () => {
	it("parses the handover example", () => {
		const c = parseVerifyConfig(FULL);
		expect(c.setup).toEqual(["pnpm install --frozen-lockfile", "pnpm db:migrate && pnpm db:seed"]);
		expect(c.start).toBe("pnpm dev --port 3000");
		expect(c.health).toBe("http://localhost:3000/api/health");
		expect(c.services.postgres).toEqual({ image: "postgres:16", env: { POSTGRES_PASSWORD: "test" }, port: 5432, command: undefined });
		expect(c.env.DATABASE_URL).toContain("@postgres:5432");
		expect(c.login).toEqual({ email: "qa@example.com", username: undefined, password: "qa-password" });
		expect(c.timeouts).toEqual({ setupSec: 900, bootSec: 180 });
	});

	it("defaults health to url and accepts a single setup string", () => {
		const c = parseVerifyConfig("setup: npm ci\nstart: npm start\nurl: http://localhost:8080/app\n");
		expect(c.setup).toEqual(["npm ci"]);
		expect(c.health).toBe("http://localhost:8080/app");
		expect(c.services).toEqual({});
	});

	it("stringifies scalar env values", () => {
		expect(parseVerifyConfig("start: x\nurl: http://a\nenv: { PORT: 3000, DEBUG: true }").env).toEqual({ PORT: "3000", DEBUG: "true" });
	});

	it.each([
		["start: x", /url/],
		["url: http://a", /start/],
		["start: x\nurl: localhost:3000", /absolute http\(s\) URL/],
		["start: x\nurl: ftp://a", /absolute http\(s\) URL/],
		["start: x\nurl: http://a\nservices: { Bad_Name: { image: x } }", /name must match/],
		["start: x\nurl: http://a\nservices: { db: { image: x, port: 99999 } }", /port/],
		["start: x\nurl: http://a\nenv: { 'A-B': c }", /invalid variable name/],
		["start: x\nurl: http://a\nsetpu: [x]", /unknown key: setpu/],
		["start: x\nurl: http://a\ntimeouts: { boot: -1 }", /positive/],
		["- a\n- b", /must be a map/],
		["start: [unclosed", /not valid YAML/],
	])("rejects %j", (text, msg) => {
		expect(() => parseVerifyConfig(text)).toThrow(ConfigError);
		expect(() => parseVerifyConfig(text)).toThrow(msg);
	});

	it("lists the login password as a secret", () => {
		expect(configSecrets(parseVerifyConfig(FULL))).toEqual(["qa-password"]);
		expect(configSecrets(parseVerifyConfig("start: x\nurl: http://a"))).toEqual([]);
	});
});
