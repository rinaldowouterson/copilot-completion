/**
 * Shared debounce timer for GHOST and NES.
 *
 * Both pipelines call `waitForDebounce()` before firing a network request.
 * The timer is shared: a keystroke that cancels a GHOST request also resets
 * the debounce for NES, and vice versa.
 *
 * Only `lastCancelledTime` is shared between pipelines. Each call to
 * `waitForDebounce` owns its own timeout ID, so GHOST and NES never
 * clear each other's pending timers.
 */

let lastCancelledTime = 0;

/**
 * Wait until `debounceMs` ms have elapsed since the last user keystroke.
 * If the user types again during the wait, the timer resets automatically
 * because `lastCancelledTime` is updated by the cancellation listener.
 *
 * @returns true if the debounce completed (silence achieved), false if aborted.
 */
export function waitForDebounce(
    debounceMs: number,
    abortSignal: AbortSignal,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const check = () => {
            if (abortSignal.aborted) {
                resolve(false);
                return;
            }
            const elapsed = Date.now() - lastCancelledTime;
            if (elapsed >= debounceMs) {
                resolve(true);
            } else {
                setTimeout(check, debounceMs - elapsed);
            }
        };
        check();
    });
}

/** Notify the shared debounce timer that a user keystroke occurred. */
export function notifyCancelled(): void {
    lastCancelledTime = Date.now();
}

/** Exported for testing / diagnostics. */
export function getLastCancelledTime(): number {
    return lastCancelledTime;
}
