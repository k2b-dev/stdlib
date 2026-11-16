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
 * - `drop` (default): the new call is ignored. It runs nothing, changes no state, and its
 *   Promise resolves.
 * - `replace`: the new call starts anyway. When it reaches its mutation function, it becomes
 *   the source of truth and the result of the older run is discarded; the older work keeps running.
 */
type MutationConcurrency = "drop" | "replace";

/** The call that failed, passed to `onError`. */
type MutationRun = {
  /**
   * Repeats exactly this call with its variables, also after other calls have run.
   * A call that failed in `onBefore` runs `onBefore` again; a call that failed in the
   * mutation function reuses its context and skips `onBefore`, like `retry()`.
   * Follows `concurrency`.
   */
  retry: () => Promise<void>;
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
  /** Signal returning the error or null */
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
   * equal results in a row.
   */
  settledAt: Accessor<number | null>;
  /**
   * Triggers the mutation with the given variables.
   * Returns a Promise that resolves when the mutation is complete, or right away when the call
   * is dropped because another call is pending or loading (see `concurrency`).
   * Mutation failures are reported through `error` and `onError`; the Promise rejects
   * only with errors thrown by `onSuccess` or by consumers while the result is committed.
   * The `onBefore` hook is executed during this call.
   */
  mutate: (vars: V) => Promise<void>;
  /**
   * Aborts the current running mutation (if any).
   * The mutation function must support cancellation via an AbortSignal passed in the context.
   * Nothing runs yet while `onBefore` is pending, so there is nothing to abort then.
   */
  abort: () => void;
  /**
   * Retries the last started mutation using the same arguments and base context as that call.
   * **Note:** The `onBefore` hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   * Follows `concurrency`.
   */
  retry: () => Promise<void>;
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
   * `onFinally` runs without a context, `mutate()` resolves, and `retry()` does not repeat it.
   * Ask first, then make optimistic changes, so a cancel has nothing to undo.
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
   */
  onAbort?: (ctx?: C & { abortSignal: AbortSignal }) => void;

  /**
   * Optional callback executed after the mutation completes,
   * regardless of success, error, or abort.
   * This callback is called after loading is set to false.
   * It receives the combined context.
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
  let pendingCalls = 0;
  let lastSettledAt: number | null = null;

  // Store the current AbortController so we can cancel the mutation.
  // It is set exactly while the current run's mutation function is running.
  let currentAbortController: AbortController | null = null;

  // Store the last runnable invocation so retry also works when vars are undefined.
  let lastInvocation: { vars: V; baseCtx: C | undefined } | undefined;

  const busy = () => pendingCalls > 0 || currentAbortController !== null;
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
   * Private helper that runs the mutation.
   *
   * @param vars - The mutation variables.
   * @param baseCtx - An optional base context. If provided, the onBefore hook is NOT re‑executed.
   */
  const runMutation = async (vars: V, baseCtx?: C): Promise<void> => {
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
        if (!isCurrent()) return;
        // AbortError surfacing as an exception (typical fetch behaviour) is
        // routed to onAbort, not onError, since the user explicitly cancelled.
        const isAbortError =
          abortController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (isAbortError) {
          finish("aborted");
          options.onAbort?.(combinedCtx);
        } else {
          const error = normalizeError(err);
          finish("error", () => setError(error));
          options.onError?.(error, combinedCtx, {
            retry: () => (dropped() ? Promise.resolve() : runMutation(vars, baseCtx)),
          });
        }
        return;
      }

      // If a newer mutation has been kicked off, drop this stale result on
      // the floor — the newer mutation's outcome is the source of truth.
      if (!isCurrent()) return;

      // If the mutation was aborted, trigger the onAbort callback.
      if (abortController.signal.aborted) {
        finish("aborted");
        options.onAbort?.(combinedCtx);
      } else {
        finish("success", () => safeSetData(result));
        options.onSuccess?.(result, combinedCtx);
      }
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
  const mutate = async (vars: V): Promise<void> => {
    if (dropped()) return;
    if (!options.onBefore) {
      await runMutation(vars, undefined);
      return;
    }

    pendingCalls++;
    setPending(pendingCalls);
    let cancelled = false;
    const cancel = (): never => {
      cancelled = true;
      throw new MutationCancelled("Mutation cancelled in onBefore");
    };

    let baseCtx: C | undefined = undefined;
    let failure: Error | undefined;
    try {
      baseCtx = await options.onBefore(vars, { cancel });
    } catch (err: unknown) {
      failure = normalizeError(err);
    }
    pendingCalls--;

    if (cancelled) {
      settle("aborted", () => setPending(pendingCalls));
      options.onFinally?.(undefined);
      return;
    }
    if (failure) {
      const error = failure;
      settle("error", () => {
        setPending(pendingCalls);
        setError(error);
      });
      // Context is undefined because onBefore failed before producing a context
      options.onError?.(error, undefined, { retry: () => mutate(vars) });
      options.onFinally?.(undefined);
      return;
    }
    await runMutation(vars, baseCtx);
  };

  /**
   * Aborts the currently running mutation, if any.
   * The mutation function must support cancellation via the abort signal provided in the context.
   */
  const abort = () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  };

  /**
   * Retries the last mutation using the same arguments and base context as the previous call.
   * **Note:** The onBefore hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   */
  const retry = async (): Promise<void> => {
    if (lastInvocation && !dropped()) {
      await runMutation(lastInvocation.vars, lastInvocation.baseCtx);
    }
  };

  return { data, error, loading, status, settledAt, mutate, abort, retry };
};

export const mutation = {
  create,
} as const;

export type { MutationResult, MutationOptions, MutationStatus, MutationConcurrency, MutationRun };
