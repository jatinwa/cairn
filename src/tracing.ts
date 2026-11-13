/**
 * A tracing seam, deliberately shaped as a **strict subset of OpenTelemetry's
 * own API**.
 *
 * The point of the shape is that it costs nothing to satisfy. An OTel tracer
 * already has `startSpan`, and its spans already have `setAttribute`,
 * `recordException` and `end`, so this works with no adapter:
 *
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * createWorker({ client: pool, workflows, tracer: trace.getTracer("cairn") });
 * ```
 *
 * Anything else that can start and end a named, attributed interval works too.
 * This keeps ADR-003's no-runtime-dependency rule intact without making
 * instrumentation somebody else's problem.
 */

export type SpanAttributeValue = string | number | boolean;

export interface SpanOptions {
  readonly attributes?: Record<string, SpanAttributeValue>;
}

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): void;
  /**
   * `Error | string` rather than `unknown`, so OpenTelemetry's own `Span` is
   * assignable here. Callers narrow before calling.
   */
  recordException(error: Error | string): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

const noopSpan: Span = {
  setAttribute: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};

/**
 * The default. Having one means the instrumentation has no conditionals in it —
 * every path starts and ends a span, and an un-traced deployment pays a few
 * empty function calls.
 */
export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};

/**
 * Run `body` inside a span, ending it either way and recording a thrown error.
 */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, SpanAttributeValue>,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    return await body(span);
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    throw error;
  } finally {
    span.end();
  }
}
