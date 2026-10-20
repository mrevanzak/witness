import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import Docker from "dockerode";
import { ControlClient } from "./control-client.ts";
import type { Computer, ComputerProvider, ComputerSpec, ServiceSpec } from "./types.ts";

export const DEFAULT_IMAGE = "acv-computer:dev";
const LABEL = "acv.run";
const LABEL_ROLE = "acv.role";
const GB = 1024 ** 3;

/**
 * dockerode reads DOCKER_HOST or /var/run/docker.sock but not docker contexts, so
 * also try the Docker Desktop and OrbStack per-user sockets.
 */
export function dockerFromEnv(): Docker {
	if (process.env.DOCKER_HOST) return new Docker();
	const candidates = ["/var/run/docker.sock", `${homedir()}/.orbstack/run/docker.sock`, `${homedir()}/.docker/run/docker.sock`];
	const socketPath = candidates.find((p) => existsSync(p));
	return new Docker(socketPath ? { socketPath } : undefined);
}

export interface DockerProviderOptions {
	docker?: Docker;
	image?: string;
	memoryBytes?: number;
	cpus?: number;
}

/**
 * The only component that talks to the Docker socket. The socket is never mounted
 * into run containers. The control port is published on host loopback with an
 * ephemeral port (macOS cannot reach bridge IPs) and protected by a per-run token.
 */
export class DockerComputerProvider implements ComputerProvider {
	readonly docker: Docker;
	private readonly image: string;
	private readonly memory: number;
	private readonly cpus: number;

	constructor(opts: DockerProviderOptions = {}) {
		this.docker = opts.docker ?? dockerFromEnv();
		this.image = opts.image ?? process.env.ACV_COMPUTER_IMAGE ?? DEFAULT_IMAGE;
		this.memory = opts.memoryBytes ?? 4 * GB;
		this.cpus = opts.cpus ?? 2;
	}

	async create(spec: ComputerSpec): Promise<Computer> {
		const image = spec.image ?? this.image;
		await this.docker.getImage(image).inspect().catch(() => {
			throw new Error(`computer image ${image} not found; build it with \`pnpm image:build\``);
		});
		const artifactsDir = resolve(spec.artifactsDir);
		mkdirSync(artifactsDir, { recursive: true });
		// The computer runs as uid 1000; on Linux hosts the bind mount keeps host ownership.
		chmodSync(artifactsDir, 0o777);

		const labels = { [LABEL]: spec.runId };
		const networkName = `acv-${spec.runId}`;
		await this.docker.createNetwork({ Name: networkName, Driver: "bridge", Labels: labels, CheckDuplicate: true });
		const token = randomBytes(24).toString("base64url");
		const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
			"7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
		};
		if (spec.enableVnc) ports["6080/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "" }];

		try {
			const container = await this.docker.createContainer({
				name: `acv-${spec.runId}-computer`,
				Image: image,
				Hostname: "computer",
				Labels: { ...labels, [LABEL_ROLE]: "computer" },
				Env: [
					`CONTROL_TOKEN=${token}`,
					`ENABLE_VNC=${spec.enableVnc ? 1 : 0}`,
					...Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
				],
				ExposedPorts: Object.fromEntries(Object.keys(ports).map((p) => [p, {}])),
				StopSignal: "SIGTERM",
				User: "1000:1000",
				HostConfig: {
					CapDrop: ["ALL"],
					SecurityOpt: ["no-new-privileges"],
					Memory: this.memory,
					MemorySwap: this.memory,
					NanoCpus: this.cpus * 1e9,
					PidsLimit: 2048,
					ShmSize: 512 * 1024 * 1024,
					NetworkMode: networkName,
					Binds: [`${artifactsDir}:/artifacts`],
					PortBindings: ports,
					// Lets the computer reach host-only dev services (e.g. a local Supabase).
					ExtraHosts: ["host.docker.internal:host-gateway"],
				},
			});
			await container.start();
			const info = await container.inspect();
			const hostPort = (p: string) => info.NetworkSettings.Ports[p]?.[0]?.HostPort;
			const control = new ControlClient(`http://127.0.0.1:${hostPort("7070/tcp")}`, token);
			await waitFor(async () => (await control.health()).ok, 30_000, "computer control server");
			return new DockerComputer(this.docker, spec.runId, container, networkName, control, spec.enableVnc ? `http://127.0.0.1:${hostPort("6080/tcp")}/vnc.html?autoconnect=1&view_only=1` : undefined, { url: control.baseUrl, token });
		} catch (e) {
			await removeRun(this.docker, spec.runId).catch(() => undefined);
			throw e;
		}
	}

	async cleanupOrphans(): Promise<number> {
		const containers = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
		const runs = new Set(containers.map((c) => c.Labels[LABEL]));
		const networks = await this.docker.listNetworks({ filters: { label: [LABEL] } });
		for (const n of networks) runs.add(n.Labels?.[LABEL] ?? "");
		runs.delete("");
		for (const run of runs) await removeRun(this.docker, run);
		return runs.size;
	}
}

class DockerComputer implements Computer {
	readonly id: string;
	private destroyed = false;

	constructor(
		private readonly docker: Docker,
		readonly runId: string,
		private readonly container: Docker.Container,
		readonly network: string,
		private readonly controlClient: ControlClient,
		readonly liveViewUrl?: string,
		readonly control?: { url: string; token: string }
	) {
		this.id = container.id;
	}

	health() {
		return this.controlClient.health();
	}
	screenshot(opts?: Parameters<Computer["screenshot"]>[0]) {
		return this.controlClient.screenshot(opts);
	}
	act(action: Parameters<Computer["act"]>[0]) {
		return this.controlClient.act(action);
	}
	exec(req: Parameters<Computer["exec"]>[0]) {
		return this.controlClient.exec(req);
	}
	async putArchive(tar: Buffer, destDir: string) {
		await this.container.putArchive(tar, { path: destDir });
	}
	startRecording(path?: string) {
		return this.controlClient.startRecording(path);
	}
	stopRecording() {
		return this.controlClient.stopRecording();
	}
	navigate(url: string, opts?: { timeoutMs?: number }) {
		return this.controlClient.navigate(url, opts?.timeoutMs);
	}
	pageSnapshot(opts?: { maxText?: number }) {
		return this.controlClient.pageSnapshot(opts?.maxText);
	}
	consoleMessages() {
		return this.controlClient.consoleMessages();
	}
	networkEvents() {
		return this.controlClient.networkEvents();
	}
	logs(file: string, tail?: number) {
		return this.controlClient.logs(file, tail);
	}

	async startService(name: string, spec: ServiceSpec): Promise<void> {
		await pullIfMissing(this.docker, spec.image);
		const c = await this.docker.createContainer({
			name: `acv-${this.runId}-${name}`,
			Image: spec.image,
			Labels: { [LABEL]: this.runId, [LABEL_ROLE]: `service:${name}` },
			Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
			Cmd: spec.command,
			HostConfig: {
				NetworkMode: this.network,
				Memory: 2 * GB,
				MemorySwap: 2 * GB,
				NanoCpus: 1e9,
				PidsLimit: 1024,
				SecurityOpt: ["no-new-privileges"],
			},
			NetworkingConfig: { EndpointsConfig: { [this.network]: { Aliases: [name] } } },
		});
		await c.start();
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		await this.container.stop({ t: 5 }).catch(() => undefined);
		await removeRun(this.docker, this.runId);
	}
}

async function removeRun(docker: Docker, runId: string): Promise<void> {
	const containers = await docker.listContainers({ all: true, filters: { label: [`${LABEL}=${runId}`] } });
	await Promise.all(
		containers.map(async (c) => {
			const ct = docker.getContainer(c.Id);
			if (c.State === "running") await ct.stop({ t: 3 }).catch(() => undefined);
			await ct.remove({ force: true, v: true }).catch(() => undefined);
		})
	);
	const networks = await docker.listNetworks({ filters: { label: [`${LABEL}=${runId}`] } });
	await Promise.all(networks.map((n) => docker.getNetwork(n.Id).remove().catch(() => undefined)));
}

async function pullIfMissing(docker: Docker, image: string): Promise<void> {
	const present = await docker.getImage(image).inspect().then(() => true, () => false);
	if (present) return;
	const stream = await docker.pull(image);
	await new Promise<void>((res, rej) => docker.modem.followProgress(stream, (err) => (err ? rej(err) : res())));
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string, intervalMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			if (await check()) return;
		} catch (e) {
			last = e;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}
