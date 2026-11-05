// The ComputerProvider witness runs with: a simulator when witness.yaml names a
// device app, the Linux computer in Docker otherwise.
import { Effect, Layer } from "effect"
import { ComputerProvider } from "./computer.ts"
import { makeDeviceProvider } from "./device-provider.ts"
import { makeDockerProvider } from "./docker-provider.ts"

export const ComputerProviderLive = Layer.effect(
	ComputerProvider,
	Effect.gen(function* () {
		const docker = yield* makeDockerProvider
		const device = yield* makeDeviceProvider
		return ComputerProvider.of({
			cleanupOrphans: Effect.all([
				docker.cleanupOrphans,
				device.cleanupOrphans.pipe(Effect.orElseSucceed(() => 0)),
			]).pipe(Effect.map(([a, b]) => a + b)),
			create: (spec) => (spec.device ? device.create(spec) : docker.create(spec)),
		})
	})
)
