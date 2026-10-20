// ComputerProvider on Docker. The only component that talks to the Docker socket;
// the socket is never mounted into run containers. The control port is published
// on host loopback with an ephemeral port (macOS cannot reach bridge IPs) and
// protected by a per-run token.

import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import Docker from "dockerode"
import { Config, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { HttpClient } from "effect/http"
import {
	type Computer,
	ComputerImageMissingError,
	ComputerProvider,
	type ComputerSpec,
	ComputerStartTimeoutError,
	DockerError,
	type ServiceSpec,
} from "./computer.ts"
import { makeControlClient } from "./control-client.ts"

const LABEL = "witness.run"
const ROLE = "witness.role"
const GB = 1024 ** 3

/** dockerode reads DOCKER_HOST or /var/run/docker.sock but not docker contexts; also try OrbStack and Docker Desktop sockets. */
const dockerClient = (dockerHost: Option.Option<string>): Docker => {
	if (Option.isSome(dockerHost)) {
		return new Docker()
	}
	const candidates = [
		"/var/run/docker.sock",
		`${homedir()}/.orbstack/run/docker.sock`,
		`${homedir()}/.docker/run/docker.sock`,
	]
	const socketPath = candidates.find((p) => existsSync(p))
	return socketPath ? new Docker({ socketPath }) : new Docker()
}

export const DockerComputerProvider = Layer.effect(
	ComputerProvider,
	Effect.gen(function* () {
		const docker = dockerClient(yield* Config.option(Config.String("DOCKER_HOST")))
		const defaultImage = yield* Config.String("WITNESS_COMPUTER_IMAGE").pipe(Config.withDefault("witness-computer:dev"))
		const httpClient = yield* HttpClient.HttpClient

		const call = <A>(operation: string, f: () => Promise<A>) =>
			Effect.tryPromise({
				catch: (e) => new DockerError({ message: e instanceof Error ? e.message : String(e), operation }),
				try: f,
			})

		const removeRun = Effect.fn("DockerComputerProvider.removeRun")(function* (runId: string) {
			const containers = yield* call("listContainers", () =>
				docker.listContainers({ all: true, filters: { label: [`${LABEL}=${runId}`] } })
			)
			yield* Effect.forEach(
				containers,
				(c) => {
					const ct = docker.getContainer(c.Id)
					return (c.State === "running" ? call("stop", () => ct.stop({ t: 3 })).pipe(Effect.ignore) : Effect.void).pipe(
						Effect.andThen(call("remove", () => ct.remove({ force: true, v: true })).pipe(Effect.ignore))
					)
				},
				{ concurrency: "unbounded", discard: true }
			)
			const networks = yield* call("listNetworks", () =>
				docker.listNetworks({ filters: { label: [`${LABEL}=${runId}`] } })
			)
			yield* Effect.forEach(
				networks,
				(n) => call("removeNetwork", () => docker.getNetwork(n.Id).remove()).pipe(Effect.ignore),
				{ discard: true }
			)
		})

		const cleanupOrphans = Effect.gen(function* () {
			const containers = yield* call("listContainers", () =>
				docker.listContainers({ all: true, filters: { label: [LABEL] } })
			)
			const networks = yield* call("listNetworks", () => docker.listNetworks({ filters: { label: [LABEL] } }))
			const runs = new Set([
				...containers.map((c) => c.Labels[LABEL] ?? ""),
				...networks.map((n) => n.Labels?.[LABEL] ?? ""),
			])
			runs.delete("")
			yield* Effect.forEach(runs, removeRun, { discard: true })
			return runs.size
		}).pipe(Effect.withSpan("DockerComputerProvider.cleanupOrphans"))

		const pullIfMissing = (image: string) =>
			call("inspectImage", () => docker.getImage(image).inspect()).pipe(
				Effect.asVoid,
				Effect.catchTag("DockerError", () =>
					call("pull", async () => {
						const stream = await docker.pull(image)
						await new Promise<void>((res, rej) =>
							docker.modem.followProgress(stream, (err: Error | null) => (err ? rej(err) : res()))
						)
					})
				)
			)

		const acquire = Effect.fnUntraced(function* (spec: ComputerSpec) {
			const image = spec.image ?? defaultImage
			yield* call("inspectImage", () => docker.getImage(image).inspect()).pipe(
				Effect.catchTag("DockerError", () =>
					Effect.fail(
						new ComputerImageMissingError({
							image,
							message: `computer image ${image} not found; build it with \`witness image\` (\`pnpm image:build\` in a witness checkout)`,
						})
					)
				)
			)
			const artifactsDir = resolve(spec.artifactsDir)
			mkdirSync(artifactsDir, { recursive: true })
			// The computer runs as uid 1000; on Linux hosts the bind mount keeps host ownership.
			chmodSync(artifactsDir, 0o777)

			const labels = { [LABEL]: spec.runId }
			const network = `witness-${spec.runId}`
			yield* call("createNetwork", () =>
				docker.createNetwork({ CheckDuplicate: true, Driver: "bridge", Labels: labels, Name: network })
			)
			const token = Redacted.make(randomBytes(24).toString("base64url"))
			const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
				"7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
			}
			if (spec.enableVnc) {
				ports["6080/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "" }]
			}
			const memory = (spec.memoryGb ?? 4) * GB

			const container = yield* call("createContainer", () =>
				docker.createContainer({
					Env: [
						`CONTROL_TOKEN=${Redacted.value(token)}`,
						`ENABLE_VNC=${spec.enableVnc ? 1 : 0}`,
						...Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
					],
					ExposedPorts: Object.fromEntries(Object.keys(ports).map((p) => [p, {}])),
					HostConfig: {
						Binds: [`${artifactsDir}:/artifacts`],
						CapDrop: ["ALL"],
						// Lets the computer reach host-only dev services (e.g. a local Supabase).
						ExtraHosts: ["host.docker.internal:host-gateway"],
						Memory: memory,
						MemorySwap: memory,
						NanoCpus: (spec.cpus ?? 2) * 1e9,
						NetworkMode: network,
						PidsLimit: 2048,
						PortBindings: ports,
						SecurityOpt: ["no-new-privileges"],
						ShmSize: 512 * 1024 * 1024,
					},
					Hostname: "computer",
					Image: image,
					Labels: { ...labels, [ROLE]: "computer" },
					name: `witness-${spec.runId}-computer`,
					StopSignal: "SIGTERM",
					User: "1000:1000",
				})
			)
			yield* call("start", () => container.start())
			const info = yield* call("inspect", () => container.inspect())
			const hostPort = (p: string) => info.NetworkSettings.Ports[p]?.[0]?.HostPort
			const url = `http://127.0.0.1:${hostPort("7070/tcp")}`
			const control = yield* makeControlClient(url, Redacted.value(token)).pipe(
				Effect.provideService(HttpClient.HttpClient, httpClient)
			)

			yield* control.health.pipe(
				Effect.filterOrFail((h) => h.ok),
				Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
				Effect.mapError(
					() =>
						new ComputerStartTimeoutError({
							message: "control server did not become healthy within 30 s",
							runId: spec.runId,
						})
				)
			)

			const startService = Effect.fn("Computer.startService")(function* (name: string, svc: ServiceSpec) {
				yield* pullIfMissing(svc.image)
				const c = yield* call("createService", () =>
					docker.createContainer({
						Env: Object.entries(svc.env ?? {}).map(([k, v]) => `${k}=${v}`),
						Image: svc.image,
						Labels: { [LABEL]: spec.runId, [ROLE]: `service:${name}` },
						name: `witness-${spec.runId}-${name}`,
						...(svc.command ? { Cmd: [...svc.command] } : {}),
						HostConfig: {
							Memory: 2 * GB,
							MemorySwap: 2 * GB,
							NanoCpus: 1e9,
							NetworkMode: network,
							PidsLimit: 1024,
							SecurityOpt: ["no-new-privileges"],
						},
						NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
					})
				)
				yield* call("startService", () => c.start())
			})

			const computer: Computer = {
				...control,
				control: { token: Redacted.value(token), url },
				id: container.id,
				liveView: spec.enableVnc
					? `http://127.0.0.1:${hostPort("6080/tcp")}/vnc_lite.html?view_only=true&scale=true`
					: undefined,
				network,
				putArchive: (tar, destDir) =>
					call("putArchive", () => container.putArchive(Buffer.from(tar), { path: destDir })).pipe(Effect.asVoid),
				runId: spec.runId,
				startService,
			}
			return computer
		})

		const create = Effect.fn("DockerComputerProvider.create")(function* (
			spec: ComputerSpec & { readonly keep?: boolean }
		) {
			return yield* Effect.acquireRelease(
				// A half-created run (failed health check) is removed before the error propagates.
				acquire(spec).pipe(Effect.onError(() => removeRun(spec.runId).pipe(Effect.ignore))),
				(c) =>
					spec.keep
						? Effect.logInfo("computer kept", {
								cleanup: `docker rm -f $(docker ps -aq --filter label=${LABEL}=${spec.runId})`,
								id: c.id.slice(0, 12),
							})
						: call("stop", () => docker.getContainer(c.id).stop({ t: 5 })).pipe(
								Effect.ignore,
								Effect.andThen(removeRun(spec.runId)),
								Effect.ignore
							)
			)
		})

		return ComputerProvider.of({ cleanupOrphans, create, removeRun })
	})
)
