import { parse } from "yaml";
import type { ServiceSpec } from "@witness/computer";

/** `witness.yaml` at the repo root: how to set up, start and reach the app under test. */
export interface VerifyConfig {
	setup: string[];
	start: string;
	url: string;
	/** Defaults to `url`. */
	health: string;
	services: Record<string, ServiceSpec>;
	/** Non-secret env for setup/start commands. */
	env: Record<string, string>;
	/** Optional test account the agent may use. The password is a secret: never logged or captioned. */
	login?: { email?: string; username?: string; password?: string };
	timeouts: { setupSec: number; bootSec: number };
	/**
	 * Host files copied into the app directory before setup, `{ "<dest in app>": "<host path>" }`.
	 * Only honoured in a config passed with --config (never from the repo under test).
	 */
	files: Record<string, string>;
	/** Host KEY=VALUE file whose variables reach setup/start and whose values are redacted everywhere. */
	secretEnv?: string;
}

export class ConfigError extends Error {}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const str = (v: unknown, path: string): string => {
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${path} must be a non-empty string`);
	return v;
};

const strMap = (v: unknown, path: string): Record<string, string> => {
	if (v == null) return {};
	if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${path} must be a map`);
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (!ENV_KEY.test(k)) throw new ConfigError(`${path}.${k}: invalid variable name`);
		out[k] = str(val, `${path}.${k}`);
	}
	return out;
};

const httpUrl = (v: unknown, path: string): string => {
	const s = str(v, path);
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new ConfigError(`${path} must be an absolute http(s) URL, got ${s}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${path} must be an absolute http(s) URL, got ${s}`);
	return s;
};

export function parseVerifyConfig(text: string): VerifyConfig {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (e) {
		throw new ConfigError(`witness.yaml is not valid YAML: ${(e as Error).message}`);
	}
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("witness.yaml must be a map");
	const r = raw as Record<string, unknown>;
	const known = new Set(["setup", "start", "url", "health", "services", "env", "login", "timeouts", "files", "secret_env"]);
	for (const k of Object.keys(r)) if (!known.has(k)) throw new ConfigError(`unknown key: ${k}`);

	const setup = r.setup == null ? [] : Array.isArray(r.setup) ? r.setup.map((c, i) => str(c, `setup[${i}]`)) : [str(r.setup, "setup")];
	const url = httpUrl(r.url, "url");

	const services: Record<string, ServiceSpec> = {};
	if (r.services != null) {
		if (typeof r.services !== "object" || Array.isArray(r.services)) throw new ConfigError("services must be a map");
		for (const [name, s] of Object.entries(r.services as Record<string, unknown>)) {
			if (!NAME.test(name)) throw new ConfigError(`services.${name}: name must match ${NAME}`);
			if (s == null || typeof s !== "object") throw new ConfigError(`services.${name} must be a map`);
			const svc = s as Record<string, unknown>;
			const port = svc.port == null ? undefined : Number(svc.port);
			if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new ConfigError(`services.${name}.port must be a port number`);
			const command = svc.command == null ? undefined : Array.isArray(svc.command) ? svc.command.map((c, i) => str(c, `services.${name}.command[${i}]`)) : ["sh", "-c", str(svc.command, `services.${name}.command`)];
			services[name] = { image: str(svc.image, `services.${name}.image`), env: strMap(svc.env, `services.${name}.env`), port, command };
		}
	}

	let login: VerifyConfig["login"];
	if (r.login != null) {
		if (typeof r.login !== "object" || Array.isArray(r.login)) throw new ConfigError("login must be a map");
		const l = r.login as Record<string, unknown>;
		login = {
			email: l.email == null ? undefined : str(l.email, "login.email"),
			username: l.username == null ? undefined : str(l.username, "login.username"),
			password: l.password == null ? undefined : str(l.password, "login.password"),
		};
	}

	const t = (r.timeouts ?? {}) as Record<string, unknown>;
	const sec = (v: unknown, d: number, path: string) => {
		if (v == null) return d;
		const n = Number(v);
		if (!(n > 0)) throw new ConfigError(`${path} must be a positive number of seconds`);
		return n;
	};

	return {
		setup,
		start: str(r.start, "start"),
		url,
		health: r.health == null ? url : httpUrl(r.health, "health"),
		services,
		env: strMap(r.env, "env"),
		login,
		timeouts: { setupSec: sec(t.setup, 900, "timeouts.setup"), bootSec: sec(t.boot, 180, "timeouts.boot") },
		files: Object.fromEntries(
			Object.entries(r.files == null ? {} : (r.files as Record<string, unknown>)).map(([dest, src]) => {
				if (dest.startsWith("/") || dest.split("/").includes("..")) throw new ConfigError(`files.${dest}: destination must be relative to the app`);
				return [dest, str(src, `files.${dest}`)];
			})
		),
		secretEnv: r.secret_env == null ? undefined : str(r.secret_env, "secret_env"),
	};
}

/** Parses a KEY=VALUE env file (comments, blank lines and `export ` prefixes allowed). */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim().replace(/^export\s+/, "");
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		if (ENV_KEY.test(key)) out[key] = value;
	}
	return out;
}

/** Values that must never appear in logs, steps, captions or reports. */
export function configSecrets(cfg: VerifyConfig): string[] {
	return [cfg.login?.password].filter((s): s is string => !!s && s.length >= 3);
}
