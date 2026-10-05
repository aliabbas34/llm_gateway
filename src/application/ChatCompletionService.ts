import {
  AttemptClosedError,
  BudgetExhaustedError,
  ShuttingDownError,
  UpstreamUnavailableError,
} from '../domain/errors.js';
import { ProviderError, type ProviderErrorKind } from '../domain/providerErrors.js';
import type {
  BudgetStore,
  Clock,
  ResolvedModel,
  SettleResult,
  TokenCounter,
} from '../domain/ports.js';
import type {
  AttemptClaims,
  ChatMessage,
  ModelRef,
  Outcome,
  ProviderRequest,
  Usage,
  UsageEntry,
} from '../domain/types.js';
import type { ChatSink } from './ChatSink.js';
import { buildProviderMessages } from './messagePolicy.js';
import { ModelStreamer, type ModelRun } from './ModelStreamer.js';
import { ReservationHandle } from './ReservationHandle.js';
import type { UsageRecorder } from './UsageRecorder.js';
import type { StreamTimeouts } from './Watchdog.js';

export interface ChatInput {
  readonly requestId: string;
  readonly claims: AttemptClaims;
  readonly messages: readonly ChatMessage[];
  /** Time already spent in the HTTP pipeline (rate limits, auth, validation) before this call. */
  readonly pipelineMs?: number;
}

/** How the reservation ended, from this request's point of view. */
export type Settlement = 'settled' | 'already_settled' | 'failed';

/** What happened, for logs and metrics. Contains no message text. */
export interface ChatResult {
  readonly outcome: Outcome;
  readonly model: ModelRef | null;
  readonly usage: Usage;
  readonly usageSource: 'provider' | 'estimated';
  readonly ttftMs: number | null;
  /**
   * NFR3: what the gateway added before the first token = pipeline time + (TTFT − the serving
   * model's own TTFT). Includes time spent on failed candidates. Null if nothing was streamed.
   */
  readonly addedLatencyMs: number | null;
  readonly latencyMs: number;
  /** Candidates that failed before the one that served (or before giving up). */
  readonly failoverCount: number;
  /** Error kinds of the failed candidates, in order (for logs/metrics). */
  readonly failoverReasons: readonly ProviderErrorKind[];
  readonly reservedTokens: number;
  /** Null unless this request settled its own reservation. */
  readonly chargedTokens: number | null;
  readonly remainingTokens: number | null;
  readonly settlement: Settlement;
}

/** The chat use case as the HTTP layer sees it. Implemented by the service and its decorators. */
export interface ChatCompletion {
  complete(input: ChatInput, sink: ChatSink, clientSignal: AbortSignal): Promise<ChatResult>;
}

export interface ChatCompletionDeps {
  /** Primary first, then fallbacks (FR6). */
  readonly models: readonly ResolvedModel[];
  readonly counter: TokenCounter;
  readonly clock: Clock;
  readonly systemPrompt: string;
  readonly budget: BudgetStore;
  readonly usage: UsageRecorder;
  readonly timeouts: StreamTimeouts & {
    /** Hard cap on the whole request, across failovers (ADR-0011). */
    readonly maxStreamDurationMs: number;
  };
}

type SettleOutcome = SettleResult | { readonly status: 'failed'; readonly error: unknown };

/**
 * One chat completion, end to end:
 *   message policy → estimate input → RESERVE → stream (with failover) → RECONCILE → ledger.
 *
 * Reservation lifecycle (ADR-0004): reserve is the first I/O, and a single try/finally owns the
 * handle until it is settled. Normal paths settle explicitly (reconcile after streaming, release
 * when nothing was consumed); the finally is the safety net for anything unexpected.
 *
 * Failover (FR6): only before the first byte reaches the client, only to the configured fallback
 * models, and only for retryable failures (429 / 5xx / timeout / connection).
 *
 * Ledger rule: whoever settles a reservation writes its ledger row. If our settle fails (Redis
 * down at the end), the sweeper settles it later and writes `expired_unreconciled`.
 */
export class ChatCompletionService implements ChatCompletion {
  private readonly streamer: ModelStreamer;

  constructor(private readonly deps: ChatCompletionDeps) {
    this.streamer = new ModelStreamer(deps.clock, deps.timeouts);
  }

  async complete(input: ChatInput, sink: ChatSink, clientSignal: AbortSignal): Promise<ChatResult> {
    const startedAt = this.deps.clock.monotonicMs();
    const messages = buildProviderMessages(input.messages, this.deps.systemPrompt);
    const inputTokens = this.deps.counter.countMessages(messages);

    const reservation = await this.reserve(input, inputTokens, startedAt);
    const deadline = this.startDeadline();
    try {
      const signal = AbortSignal.any([clientSignal, deadline.signal]);
      return await this.streamReserved(
        input,
        messages,
        inputTokens,
        reservation,
        sink,
        signal,
        startedAt,
      );
    } finally {
      deadline.cancel();
      // Safety net: only reached unsettled if something threw unexpectedly.
      if (!reservation.settled) await reservation.release().catch(() => undefined);
    }
  }

  private async reserve(
    input: ChatInput,
    inputTokens: number,
    startedAt: number,
  ): Promise<ReservationHandle> {
    const { claims } = input;
    const result = await this.deps.budget.reserve({
      attemptId: claims.attemptId,
      reservationId: input.requestId,
      studentId: claims.studentId,
      initialBudget: claims.tokenBudget,
      maxTokensCap: claims.maxTokensCap,
      inputTokens,
    });
    if (result.status === 'reserved') {
      return new ReservationHandle(
        this.deps.budget,
        claims.attemptId,
        input.requestId,
        result.reservedTokens,
        result.effectiveMaxTokens,
      );
    }

    // Rejected: nothing reserved, nothing to settle; record the refusal and answer 403.
    this.deps.usage.record(
      this.ledgerEntry(input, {
        outcome: result.status,
        model: null,
        usage: { inputTokens, outputTokens: 0 },
        reservedTokens: 0,
        chargedTokens: 0,
        ttftMs: null,
        latencyMs: this.deps.clock.monotonicMs() - startedAt,
        failoverCount: 0,
      }),
    );
    throw result.status === 'attempt_closed'
      ? new AttemptClosedError('attempt is closed')
      : new BudgetExhaustedError(`remaining ${result.remainingTokens} below useful minimum`);
  }

  private async streamReserved(
    input: ChatInput,
    messages: ChatMessage[],
    inputTokens: number,
    reservation: ReservationHandle,
    sink: ChatSink,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ChatResult> {
    if (this.deps.models.length === 0) throw new Error('no models configured');
    const failed: ProviderError[] = [];
    let run: ModelRun | undefined;

    for (const model of this.deps.models) {
      const request: ProviderRequest = {
        model: model.ref.model,
        messages,
        // The provider may never produce more than was reserved (hard limit, FR5).
        maxTokens: reservation.effectiveMaxTokens,
      };
      try {
        run = await this.streamer.run(model, request, sink, signal, startedAt);
        break;
      } catch (err) {
        // Only a classified provider failure before commit lands here. Anything else is a bug:
        // let it propagate (the finally in complete() releases the reservation).
        if (!(err instanceof ProviderError)) throw err;
        failed.push(err);
        if (!err.retryable || signal.aborted) break; // FR6: no failover for these
      }
    }

    if (run === undefined) {
      return this.failBeforeFirstByte(input, inputTokens, reservation, failed, startedAt);
    }
    if (run.outcome === 'shutdown_aborted' && !sink.opened) {
      return this.refuseForShutdown(input, inputTokens, reservation, run, failed, startedAt);
    }

    // Charge what was used, capped at the reservation, BEFORE telling the client we're done:
    // a follow-up request then already sees the refund.
    const usage = this.finalUsage(run, inputTokens);
    const settled = await this.settle(() =>
      reservation.reconcile(usage.inputTokens + usage.outputTokens),
    );

    if (run.outcome === 'stream_error') {
      await (run.error?.kind === 'timeout'
        ? sink.error('upstream_timeout', 'The model provider stopped responding.')
        : sink.error('upstream_error', 'The model provider failed mid-response.'));
    } else if (run.outcome === 'shutdown_aborted') {
      await sink.error('shutting_down', 'The service is restarting. Please retry.');
    } else if (run.outcome === 'completed') {
      await sink.usage(usage);
    }
    await sink.end();

    const result: ChatResult = {
      outcome: run.outcome,
      model: run.model.ref,
      usage,
      usageSource: run.providerUsage ? 'provider' : 'estimated',
      ttftMs: run.ttftMs,
      addedLatencyMs:
        run.ttftMs !== null && run.upstreamTtftMs !== null
          ? (input.pipelineMs ?? 0) + run.ttftMs - run.upstreamTtftMs
          : null,
      latencyMs: this.deps.clock.monotonicMs() - startedAt,
      failoverCount: failed.length,
      failoverReasons: failed.map((e) => e.kind),
      reservedTokens: reservation.reservedTokens,
      chargedTokens: settled.status === 'settled' ? settled.chargedTokens : null,
      remainingTokens: settled.status === 'settled' ? settled.remainingTokens : null,
      settlement: settled.status,
    };
    if (settled.status === 'settled') {
      this.deps.usage.record(
        this.ledgerEntry(input, { ...result, chargedTokens: settled.chargedTokens }),
      );
    }
    return result;
  }

  /** Every candidate failed before the first byte: the student consumed nothing → release, 502. */
  private async failBeforeFirstByte(
    input: ChatInput,
    inputTokens: number,
    reservation: ReservationHandle,
    failed: readonly ProviderError[],
    startedAt: number,
  ): Promise<never> {
    const last = failed.at(-1);
    const settled = await this.settle(() => reservation.release());
    if (settled.status === 'settled') {
      const lastModel = this.deps.models[Math.max(0, failed.length - 1)]?.ref ?? null;
      this.deps.usage.record(
        this.ledgerEntry(input, {
          outcome: 'upstream_error',
          model: lastModel,
          usage: { inputTokens, outputTokens: 0 },
          reservedTokens: reservation.reservedTokens,
          chargedTokens: 0,
          ttftMs: null,
          latencyMs: this.deps.clock.monotonicMs() - startedAt,
          failoverCount: Math.max(0, failed.length - 1),
        }),
      );
    }
    throw new UpstreamUnavailableError(
      `no model produced output (${failed.map((e) => `${e.provider}:${e.kind}`).join(', ')})`,
      { cause: last },
    );
  }

  /**
   * Shutdown reached this request before its first byte: nothing was sent, so answer an ordinary
   * 503 + Retry-After (another instance can serve the retry) and give the reservation back.
   */
  private async refuseForShutdown(
    input: ChatInput,
    inputTokens: number,
    reservation: ReservationHandle,
    run: ModelRun,
    failed: readonly ProviderError[],
    startedAt: number,
  ): Promise<never> {
    const settled = await this.settle(() => reservation.release());
    if (settled.status === 'settled') {
      this.deps.usage.record(
        this.ledgerEntry(input, {
          outcome: 'shutdown_aborted',
          model: run.model.ref,
          usage: { inputTokens, outputTokens: 0 },
          reservedTokens: reservation.reservedTokens,
          chargedTokens: 0,
          ttftMs: null,
          latencyMs: this.deps.clock.monotonicMs() - startedAt,
          failoverCount: failed.length,
        }),
      );
    }
    throw new ShuttingDownError();
  }

  /** ADR-0011: abort the whole request (across failovers) at MAX_STREAM_DURATION_MS. */
  private startDeadline(): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ProviderError('timeout', 'gateway', 'max stream duration exceeded'));
    }, this.deps.timeouts.maxStreamDurationMs);
    timer.unref();
    return {
      signal: controller.signal,
      cancel: () => {
        clearTimeout(timer);
      },
    };
  }

  /**
   * Provider-reported usage when available. Otherwise (no usage chunk, client disconnect,
   * mid-stream failure) our estimate: the input plus what was actually streamed.
   */
  private finalUsage(run: ModelRun, estimatedInputTokens: number): Usage {
    return (
      run.providerUsage ?? {
        inputTokens: estimatedInputTokens,
        outputTokens: this.deps.counter.countText(run.streamedText),
      }
    );
  }

  private async settle(fn: () => Promise<SettleResult>): Promise<SettleOutcome> {
    try {
      return await fn();
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  private ledgerEntry(
    input: ChatInput,
    r: Pick<
      ChatResult,
      'outcome' | 'model' | 'usage' | 'reservedTokens' | 'ttftMs' | 'latencyMs' | 'failoverCount'
    > & { readonly chargedTokens: number },
  ): UsageEntry {
    return {
      requestId: input.requestId,
      attemptId: input.claims.attemptId,
      studentId: input.claims.studentId,
      model: r.model?.model ?? null,
      provider: r.model?.provider ?? null,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      reservedTokens: r.reservedTokens,
      chargedTokens: r.chargedTokens,
      outcome: r.outcome,
      latencyMs: r.latencyMs,
      ttftMs: r.ttftMs,
      failoverCount: r.failoverCount,
    };
  }
}
