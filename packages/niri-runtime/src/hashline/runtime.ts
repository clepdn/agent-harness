/** Abort signal helper — minimal stub for niri-runtime. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}
