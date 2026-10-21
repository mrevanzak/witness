// ComputerProvider on Docker. The only component that talks to the Docker socket;
// the socket is never mounted into run containers. The control port is published
// on host loopback with an ephemeral port (macOS cannot reach bridge IPs) and
// protected by a per-run token.

import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ServiceSpec } from "@witness/domain"
import Docker from "dockerode"
import { Config, Effect, FileSystem, Layer, Option, Redacted, Schedule } from "effect"
import { HttpClient } from "effect/http"
import {
	type Computer,
	ComputerImageMissingError,
	ComputerProvider,
	type ComputerSpec,
	ComputerStartTimeoutError,
	DockerError,
} from "./computer.ts"
import { makeControlClient } from "./control-client.ts"
import { messageOf } from "./message.ts"
import { CONTROL_PORT, SHUTDOWN_GRACE_SECONDS } from "./protocol.ts"

const LABEL = "witness.run"
const ROLE = "witness.role"
/** The pid of the witness process that owns a run, so cleanup leaves concurrent runs alone. */
const OWNER = "witness.pid"
const GB = 1024 ** 3
const CONTROL = `${CONTROL_PORT}/tcp`
const VNC = "6080/tcp"
// shortcut: a pid only identifies a live owner on this host; a Docker daemon shared across hosts needs a host label too.
const ownerAlive = (pid: string | undefined) => {
	if (pid === undefined) {
		return false
	}
	try {
		process.kill(Number(pid), 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** `docker stop` grace: the computer's shutdown budget plus start.sh's own teardown. */
const STOP_GRACE_SECONDS = SHUTDOWN_GRACE_SECONDS + 3

export const DockerComputerProvider = Layer.effect(
	ComputerProvider,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const httpClient = yield* HttpClient.HttpClient
		const defaultImage = yield* Config.String("WITNESS_COMPUTER_IMAGE").pipe(Config.withDefault("witness-computer:dev"))

		// dockerode reads DOCKER_HOST or /var/run/docker.sock but not docker contexts; also try OrbStack and Docker Desktop sockets.
		const docker = yield* Effect.gen(function* () {
			if (Option.isSome(yield* Config.option(Config.String("DOCKER_HOST")))) {
				return new Docker()
			}
			for (const socketPath of [
				"/var/run/docker.sock",
				`${homedir()}/.orbstack/run/docker.sock`,
				`${homedir()}/.docker/run/docker.sock`,
			]) {
				if (yield* fs.exists(socketPath).pipe(Effect.orElseSucceed(() => false))) {
					return new Docker({ socketPath })
				}
			}
			return new Docker()
		})

		const call = <A>(operation: string, f: () => Promise<A>) =>
			Effect.tryPromise({ catch: (e) => new DockerError({ message: messageOf(e), operation }), try: f })

		const imageExists = (image: string) =>
			call("inspectImage", () => docker.getImage(image).inspect()).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false)
			)

		/** Stops (with the shutdown grace) and removes every container and network of one run. */
		const removeRun = Effect.fn("DockerComputerProvider.removeRun")(function* (runId: string) {
			const containers = yield* call("listContainers", () =>
				docker.listContainers({ all: true, filters: { label: [`${LABEL}=${runId}`] } })
			)
			yield* Effect.forEach(
				containers,
				(c) => {
					const ct = docker.getContainer(c.Id)
					return (
						c.State === "running"
							? call("stop", () => ct.stop({ t: STOP_GRACE_SECONDS })).pipe(Effect.ignore)
							: Effect.void
					).pipe(Effect.andThen(call("remove", () => ct.remove({ force: true, v: true })).pipe(Effect.ignore)))
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
			const labelled = [...containers.map((c) => c.Labels), ...networks.map((n) => n.Labels ?? {})]
			const runs = new Set(labelled.map((l) => l[LABEL] ?? ""))
			runs.delete("")
			for (const l of labelled) {
				if (ownerAlive(l[OWNER])) {
					runs.delete(l[LABEL] ?? "")
				}
			}
			yield* Effect.forEach(runs, removeRun, { discard: true })
			return runs.size
		}).pipe(Effect.withSpan("DockerComputerProvider.cleanupOrphans"))

		const pullIfMissing = Effect.fnUntraced(function* (image: string) {
			if (yield* imageExists(image)) {
				return
			}
			yield* call("pull", async () => {
				const stream = await docker.pull(image)
				await new Promise<void>((res, rej) =>
					docker.modem.followProgress(stream, (err: Error | null) => (err ? rej(err) : res()))
				)
			})
		})

		const acquire = Effect.fnUntraced(function* (spec: ComputerSpec) {
			const image = defaultImage
			if (!(yield* imageExists(image))) {
				return yield* new ComputerImageMissingError({
					image,
					message: `computer image ${image} not found; build it with \`witness image\` (\`pnpm image:build\` in a witness checkout)`,
				})
			}
			const artifactsDir = resolve(spec.artifactsDir)
			// The computer runs as uid 1000; on Linux hosts the bind mount keeps host ownership.
			yield* fs.makeDirectory(artifactsDir, { recursive: true }).pipe(
				Effect.andThen(fs.chmod(artifactsDir, 0o777)),
				Effect.mapError((e) => new DockerError({ message: e.message, operation: "artifactsDir" }))
			)

			const labels = { [LABEL]: spec.runId, [OWNER]: String(process.pid) }
			const network = `witness-${spec.runId}`
			yield* call("createNetwork", () =>
				docker.createNetwork({ CheckDuplicate: true, Driver: "bridge", Labels: labels, Name: network })
			)
			const token = Redacted.make(randomBytes(24).toString("base64url"))
			const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
				[CONTROL]: [{ HostIp: "127.0.0.1", HostPort: "" }],
			}
			if (spec.enableVnc) {
				ports[VNC] = [{ HostIp: "127.0.0.1", HostPort: "" }]
			}
			const memory = (spec.memoryGb ?? 4) * GB

			const container = yield* call("createContainer", () =>
				docker.createContainer({
					Env: [`CONTROL_TOKEN=${Redacted.value(token)}`, `ENABLE_VNC=${spec.enableVnc ? 1 : 0}`],
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
			const controlPort = hostPort(CONTROL)
			if (controlPort === undefined) {
				return yield* new DockerError({ message: `${CONTROL} was not published on the host`, operation: "inspect" })
			}
			const url = `http://127.0.0.1:${controlPort}`
			const control = yield* makeControlClient(url, Redacted.value(token)).pipe(
				Effect.provideService(HttpClient.HttpClient, httpClient)
			)

			yield* control.health.pipe(
				Effect.retry({ schedule: Schedule.spaced("200 millis") }),
				Effect.timeout("30 seconds"),
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
						Env: Object.entries(svc.env).map(([k, v]) => `${k}=${v}`),
						Image: svc.image,
						Labels: { ...labels, [ROLE]: `service:${name}` },
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
				id: container.id,
				liveView: spec.enableVnc
					? `http://127.0.0.1:${hostPort(VNC)}/vnc_lite.html?view_only=true&scale=true`
					: undefined,
				network,
				putArchive: (tar, destDir) =>
					call("putArchive", () => container.putArchive(Buffer.from(tar), { path: destDir })).pipe(Effect.asVoid),
				runId: spec.runId,
				startService,
			}
			return computer
		})

		const create = Effect.fn("DockerComputerProvider.create")(function* (spec: ComputerSpec) {
			return yield* Effect.acquireRelease(
				// A half-created run (failed health check) is removed before the error propagates.
				acquire(spec).pipe(Effect.onError(() => removeRun(spec.runId).pipe(Effect.ignore))),
				(c) =>
					spec.keep
						? Effect.logInfo("computer kept", {
								cleanup: `docker rm -f $(docker ps -aq --filter label=${LABEL}=${spec.runId})`,
								id: c.id.slice(0, 12),
							})
						: removeRun(spec.runId).pipe(Effect.ignore)
			)
		})

		return ComputerProvider.of({ cleanupOrphans, create })
	})
)
