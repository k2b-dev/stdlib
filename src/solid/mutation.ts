import { batch, createSignal, type Accessor } from "solid-js";

const normalizeError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

/** Thrown by `cancel()` in `onBefore` to end the hook immediately. */
class MutationCancelled extends Error {
  override name = "MutationCancelled";
}

/**
 * Where a mutation stands.
 *
 * - `idle`: no call has ended yet and none is running.
 * - `pending`: `mutate()` was called and `onBefore` is still running.
 * - `loading`: the mutation function is running.
 * - `success`, `error`, `aborted`: how the last call ended.
 */
type MutationStatus = "idle" | "pending" | "loading" | "success" | "error" | "aborted";

/**
 * What happens to a call while another one is pending or loading.
 *
 * - `drop` (default): the new call is ignored. It runs nothing, changes no state, runs no hook,
 *   and its Promise resolves `dropped`. A run that was aborted no longer counts.
 * - `replace`: the new call starts anyway. When it reaches its mutation function, it becomes
 *   the source of truth and the result of the older run is discarded (its caller gets
 *   `dropped`); the older work keeps running.
 */
type MutationConcurrency = "drop" | "replace";

/**
 * How one call ended, from the caller's point of view. `mutate()`, `retry()`, and
 * `run.retry()` resolve with it.
 *
 * - `success`: this call's result was committed.
 * - `error`: this call failed in `onBefore` or in the mutation function.
 * - `aborted`: this call was aborted with `abort()` or cancelled in `onBefore`.
 * - `dropped`: this call does not count. It ran nothing because another call was pending
 *   or loading (`concurrency: "drop"`, or `retry()` with nothing to repeat), or a newer call
 *   replaced it and its result was discarded.
 *
 * Read the outcome instead of `error()` or `data()` after `await`: those signals belong to
 * the mutation and may describe another call.
 */
type MutationOutcome = "success" | "error" | "aborted" | "dropped";

/** The call that failed, passed to `onError`. */
type MutationRun = {
  /**
   * Repeats exactly this call with its variables, also after other calls have run.
   * A call that failed in `onBefore` runs `onBefore` again; a call that failed in the
   * mutation function reuses its context and skips `onBefore`, like `retry()`.
   * Follows `concurrency`.
   */
  retry: () => Promise<MutationOutcome>;
};

/**
 * Type for the return type of create mutation.
 *
 * @template T - The type of data returned by the mutation.
 * @template V - The type of variables passed to the mutation.
 * @template C - The base type of the context returned by the onBefore hook.
 */
type MutationResult<T, V, C = unknown> = {
  /** Signal returning the mutation data or null */
  data: Accessor<T | null>;
  /**
   * Signal returning the error or null. Read `status()` first: after an abort or a
   * `cancel()` it may still hold the error of an earlier call.
   */
  error: Accessor<Error | null>;
  /** Signal indicating whether the mutation function is running */
  loading: Accessor<boolean>;
  /**
   * Signal with the current stage: `pending` while `onBefore` runs, `loading` while the
   * mutation function runs, then how the last call ended. A throw in `onSuccess` keeps `success`.
   */
  status: Accessor<MutationStatus>;
  /**
   * Signal with the time (ms, from the `now` option) of the last end: success, error, or abort.
   * `null` before the first end. Strictly increasing, so it changes on every end, also for two
   * equal results in a row. It follows the wall clock (`now`); if the clock jumps back, the
   * value can lie in the future, so cap any hold time computed from it.
   */
  settledAt: Accessor<number | null>;
  /**
   * Triggers the mutation with the given variables.
   * Resolves with this call's outcome when it ended, or with `dropped` right away when another
   * call is pending or loading (see `concurrency`).
   * Mutation failures are reported through the outcome, `error`, and `onError`; the Promise
   * rejects only with errors thrown by `onSuccess` or by consumers while the result is committed.
   * The `onBefore` hook is executed during this call.
   */
  mutate: (vars: V) => Promise<MutationOutcome>;
  /**
   * Aborts the call in flight, if any.
   * While `onBefore` is pending, the call ends `aborted` at once and its later `onBefore`
   * result is ignored. While the mutation function runs, its `abortSignal` fires; the
   * function must honour it to stop the work.
   * Either way the mutation accepts a new call right after `abort()`, also under `drop`;
   * the aborted run's late result then never writes state.
   */
  abort: () => void;
  /**
   * Retries the last started mutation using the same arguments and base context as that call.
   * **Note:** The `onBefore` hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   * Follows `concurrency`. Resolves `dropped` when there is nothing to repeat.
   */
  retry: () => Promise<MutationOutcome>;
};

/**
 * Options for the mutation.
 *
 * @template T - The type of data returned by the mutation function.
 * @template V - The type of variables passed to the mutation function.
 * @template C - The base type of the context returned by the onBefore hook.
 */
type MutationOptions<T, V, C = unknown> = {
  /**
   * The initial value of the mutation.
   * If not provided, the mutation will start with an undefined value.
   * If provided, the initial value will be returned as the data.
   */
  initialData?: T;

  /**
   * What happens to a call while another one is pending or loading. Default `drop`:
   * the new call is ignored. Use `replace` when the newest call must win, for example
   * for autosave or search as you type.
   */
  concurrency?: MutationConcurrency;

  /** Clock for `settledAt`, in milliseconds. Default `Date.now`. */
  now?: () => number;

  /**
   * The mutation function.
   * It receives the mutation variables and a combined context.
   * **Note:** The context will always include an `abortSignal` property.
   * Must return a Promise of type T.
   */
  mutation: (vars: V, ctx: C & { abortSignal: AbortSignal }) => Promise<T>;

  /**
   * Optional hook executed before the mutation starts.
   * It receives the mutation variables and should return a base context (ctx)
   * that will later be extended with the abort signal.
   * It can also return a Promise.
   *
   * Call `cancel()` to call the mutation off, for example when a confirmation is declined.
   * It ends the hook immediately; the call ends as `aborted` without `onError` or `onAbort`,
   * `onFinally` runs without a context, `mutate()` resolves `aborted`, and `retry()` does not
   * repeat it. Write `return cancel()` so TypeScript narrows after it. Ask first, then make
   * optimistic changes, so a cancel has nothing to undo. Calling `cancel()` after the hook
   * ended only throws at that place.
   */
  onBefore?: (vars: V, control: { cancel: () => never }) => C | Promise<C>;

  /**
   * Optional callback executed when the mutation is successful, after `data`,
   * `loading`, and `status` are updated. It receives the mutation result and the combined context.
   * An error thrown here rejects `mutate()` instead of reaching `error` or `onError`;
   * `status` stays `success`.
   */
  onSuccess?: (data: T, ctx?: C & { abortSignal: AbortSignal }) => void;

  /**
   * Optional callback executed if an error occurs during the mutation or in onBefore,
   * after `error`, `loading`, and `status` are updated.
   * It receives the error, the combined context (undefined when onBefore failed),
   * and the failed call, whose `retry()` repeats exactly that call.
   */
  onError?: (
    error: Error,
    ctx: (C & { abortSignal: AbortSignal }) | undefined,
    run: MutationRun,
  ) => void;

  /**
   * Optional callback executed if the mutation is aborted, after `loading` and `status`
   * are updated. It receives the combined context.
   * Runs when `abort()` was called or the mutation function threw an `AbortError`.
   * The context is `undefined` when `abort()` came while `onBefore` was still pending.
   */
  onAbort?: (ctx?: C & { abortSignal: AbortSignal }) => void;

  /**
   * Optional callback executed after the mutation completes,
   * regardless of success, error, or abort.
   * This callback is called after loading is set to false.
   * It receives the combined context. It does not run for a dropped call, so release local
   * busy flags from the outcome of `mutate()`, not only here.
   */
  onFinally?: (ctx?: C & { abortSignal: AbortSignal }) => void;
};

/**
 * Creates a mutation controller for managing async operations with lifecycle hooks.
 *
 * Provides reactive signals for data, error, loading, status, and settledAt, plus `mutate`,
 * `abort`, and `retry` controls. The `retry()` method re-uses the base context from the previous
 * execution and does NOT call `onBefore` again -- use this for one-time side effects
 * that should not be repeated on retries.
 *
 * By default a call made while another one is pending or loading is dropped
 * (`concurrency: "drop"`). Use `concurrency: "replace"` when the newest call must win.
 *
 * Does not require a SolidJS reactive owner because it registers no owner-bound cleanup.
 *
 * Side effects:
 * - Creates SolidJS signals for `data`, `error`, `loading`, `status`, and `settledAt`.
 * - Allocates an `AbortController` per mutation invocation.
 *
 * @template T - The type of data returned by the mutation.
 * @template V - The type of variables passed to the mutation function.
 * @template C - The base type of the context returned by the onBefore hook.
 *
 * @param options - The options for the mutation.
 * @returns An object containing the mutation signals and functions.
 *
 * @example
 * ```tsx
 * const { data, error, loading, status, mutate, abort, retry } = mutation.create({
 *   mutation: async (vars, { abortSignal }) => {
 *     const res = await fetch(`/api/items`, { signal: abortSignal, method: "POST", body: JSON.stringify(vars) });
 *     return res.json();
 *   },
 *   onSuccess: (data) => console.log("Created:", data),
 *   onError: (err, _ctx, run) => console.error("Failed:", err, "retry with run.retry()"),
 * });
 *
 * // Trigger the mutation
 * mutate({ name: "New Item" });
 *
 * // Abort in-flight request
 * abort();
 *
 * // Retry the last mutation with the same variables
 * retry();
 * ```
 */
const create = <T, V, C = unknown>(options: MutationOptions<T, V, C>): MutationResult<T, V, C> => {
  const concurrency = options.concurrency ?? "drop";
  const now = options.now ?? Date.now;

  // Create signals for data, error, and loading state.
  const [data, setData] = createSignal<T | null>(options.initialData ?? null);
  const [error, setError] = createSignal<Error | null>(null);
  const [loading, setLoading] = createSignal<boolean>(false);
  // Calls whose onBefore is still running, and how the last call ended.
  const [pending, setPending] = createSignal(0);
  const [ended, setEnded] = createSignal<MutationStatus>("idle");
  const [settledAt, setSettledAt] = createSignal<number | null>(null);

  const status: Accessor<MutationStatus> = () =>
    loading() ? "loading" : pending() > 0 ? "pending" : ended();

  // Plain mirrors, so mutate() never subscribes a caller to the signals.
  // `pendingCalls` counts calls whose onBefore is running and that were not aborted.
  let pendingCalls = 0;
  let lastSettledAt: number | null = null;
  // Ends each pending call at once when abort() is called.
  const pendingAborts = new Set<() => void>();

  // Store the current AbortController so we can cancel the mutation.
  // It is set exactly while the current run's mutation function is running.
  let currentAbortController: AbortController | null = null;

  // Store the last runnable invocation so retry also works when vars are undefined.
  let lastInvocation: { vars: V; baseCtx: C | undefined } | undefined;

  // Anything still running, including a run that was aborted but has not returned yet.
  const inFlight = () => pendingCalls > 0 || currentAbortController !== null;
  // What a new call waits for under "drop": an aborted run no longer blocks.
  const busy = () =>
    pendingCalls > 0 ||
    (currentAbortController !== null && !currentAbortController.signal.aborted);
  const dropped = () => concurrency === "drop" && busy();

  /**
   * Helper to update the data signal safely.
   *
   * SolidJS interprets functions passed to setters as updater functions.
   * Wrapping a function in an arrow function ensures it is stored as a literal value.
   *
   * @param value - The new data value.
   */
  const safeSetData = (value: T) => {
    if (typeof value === "function") {
      setData(() => value);
    } else {
      setData(value as Exclude<T, Function>);
    }
  };

  /** Commits the end of a call together with `update` in one batch. */
  const settle = (outcome: "success" | "error" | "aborted", update: () => void) => {
    const at = lastSettledAt === null ? now() : Math.max(now(), lastSettledAt + 1);
    lastSettledAt = at;
    batch(() => {
      update();
      setEnded(outcome);
      setSettledAt(at);
    });
  };

  /**
   * Ends a call that never reached its mutation function. It is the end of the mutation only
   * when nothing else is in flight; otherwise the running work owns `status()` and `settledAt()`.
   */
  const settleBeforeRun = (outcome: "error" | "aborted", update?: () => void) => {
    const commit = () => {
      setPending(pendingCalls);
      update?.();
    };
    if (inFlight()) batch(commit);
    else settle(outcome, commit);
  };

  /**
   * Private helper that runs the mutation.
   *
   * @param vars - The mutation variables.
   * @param baseCtx - An optional base context. If provided, the onBefore hook is NOT re‑executed.
   */
  const runMutation = async (vars: V, baseCtx?: C): Promise<MutationOutcome> => {
    lastInvocation = { vars, baseCtx };

    // Create a new AbortController for this mutation.
    // Keep local reference so concurrent runs don't interfere.
    const abortController = new AbortController();
    currentAbortController = abortController;
    const isCurrent = () => currentAbortController === abortController;

    // Combine the provided base context (if any) with the new abort signal.
    const combinedCtx = {
      ...(baseCtx && typeof baseCtx === "object" ? baseCtx : {}),
      abortSignal: abortController.signal,
    } as C & { abortSignal: AbortSignal };

    // Ends this run before any hook runs, so hooks may start the next call.
    const finish = (outcome: "success" | "error" | "aborted", update?: () => void) => {
      currentAbortController = null;
      settle(outcome, () => {
        update?.();
        setLoading(false);
      });
    };

    try {
      batch(() => {
        setPending(pendingCalls);
        setLoading(true);
        setError(null);
      });
      let result: T;
      try {
        result = await options.mutation(vars, combinedCtx);
      } catch (err: unknown) {
        // A newer call replaced this run; its outcome is the source of truth.
        if (!isCurrent()) return "dropped";
        // AbortError surfacing as an exception (typical fetch behaviour) is
        // routed to onAbort, not onError, since the user explicitly cancelled.
        const isAbortError =
          abortController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (isAbortError) {
          finish("aborted");
          options.onAbort?.(combinedCtx);
          return "aborted";
        }
        const error = normalizeError(err);
        finish("error", () => setError(error));
        options.onError?.(error, combinedCtx, {
          retry: () => (dropped() ? Promise.resolve("dropped") : runMutation(vars, baseCtx)),
        });
        return "error";
      }

      // If a newer mutation has been kicked off, drop this stale result on
      // the floor — the newer mutation's outcome is the source of truth.
      if (!isCurrent()) return "dropped";

      // If the mutation was aborted, trigger the onAbort callback.
      if (abortController.signal.aborted) {
        finish("aborted");
        options.onAbort?.(combinedCtx);
        return "aborted";
      }
      // Clears an error that a newer call's onBefore wrote while this run was loading.
      finish("success", () => {
        setError(null);
        safeSetData(result);
      });
      options.onSuccess?.(result, combinedCtx);
      return "success";
    } finally {
      // Only reached while still current when a consumer threw before the run ended.
      if (isCurrent()) {
        currentAbortController = null;
        batch(() => {
          setPending(pendingCalls);
          setLoading(false);
        });
      }
      if (options.onFinally) {
        options.onFinally(combinedCtx);
      }
    }
  };

  /**
   * Triggers the mutation using the provided variables.
   * This method executes the `onBefore` hook (if provided) to obtain the base context.
   *
   * @param vars - The variables to pass to the mutation function.
   */
  const mutate = async (vars: V): Promise<MutationOutcome> => {
    if (dropped()) return "dropped";
    const onBefore = options.onBefore;
    if (!onBefore) return runMutation(vars, undefined);

    let cancelled = false;
    const cancel = (): never => {
      cancelled = true;
      throw new MutationCancelled("Mutation cancelled in onBefore");
    };

    // This call counts as pending until onBefore ends or abort() ends it, whichever is first.
    let counted = true;
    const release = () => {
      if (!counted) return false;
      counted = false;
      pendingCalls--;
      pendingAborts.delete(abortPending);
      return true;
    };
    let wakeAborted!: () => void;
    const aborted = new Promise<"aborted">((resolve) => {
      wakeAborted = () => resolve("aborted");
    });
    const abortPending = () => {
      if (release()) wakeAborted();
    };
    pendingCalls++;
    pendingAborts.add(abortPending);

    try {
      setPending(pendingCalls);
      const before = await Promise.race([
        (async () => onBefore(vars, { cancel }))().then(
          (ctx) => ({ ok: true as const, ctx }),
          (err: unknown) => ({ ok: false as const, error: normalizeError(err) }),
        ),
        aborted,
      ]);

      // release() is false when abort() already ended this call, also right after onBefore
      // finished but before this line ran; whatever onBefore returned is ignored then.
      if (before === "aborted" || !release()) {
        settleBeforeRun("aborted");
        options.onAbort?.(undefined);
        options.onFinally?.(undefined);
        return "aborted";
      }

      if (cancelled) {
        settleBeforeRun("aborted");
        options.onFinally?.(undefined);
        return "aborted";
      }
      if (!before.ok) {
        const error = before.error;
        settleBeforeRun("error", () => setError(error));
        // Context is undefined because onBefore failed before producing a context
        options.onError?.(error, undefined, { retry: () => mutate(vars) });
        options.onFinally?.(undefined);
        return "error";
      }
      return await runMutation(vars, before.ctx);
    } finally {
      // Only still counted when a consumer threw while this call became pending.
      if (release()) setPending(pendingCalls);
    }
  };

  /**
   * Aborts the call in flight: pending calls end at once, a running mutation function
   * gets its abort signal.
   */
  const abort = () => {
    for (const abortPending of [...pendingAborts]) abortPending();
    if (currentAbortController) {
      currentAbortController.abort();
    }
  };

  /**
   * Retries the last mutation using the same arguments and base context as the previous call.
   * **Note:** The onBefore hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   */
  const retry = async (): Promise<MutationOutcome> => {
    if (!lastInvocation || dropped()) return "dropped";
    return runMutation(lastInvocation.vars, lastInvocation.baseCtx);
  };

  return { data, error, loading, status, settledAt, mutate, abort, retry };
};

export const mutation = {
  create,
} as const;

export type {
  MutationResult,
  MutationOptions,
  MutationStatus,
  MutationConcurrency,
  MutationOutcome,
  MutationRun,
};
