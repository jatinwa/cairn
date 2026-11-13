import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { executeTask } from "../src/execute.js";
import { claimTasks, startRun, type ClaimedTask } from "../src/store.js";
import type { SpanAttributeValue, Tracer } from "../src/tracing.js";
import { defineWorkflow, sleep, step, type RegisteredWorkflow } from "../src/workflow.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

interface Recorded {
  name: string;
  attributes: Record<string, SpanAttributeValue>;
  exceptions: string[];
  ended: boolean;
}

function recordingTracer(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];
  return {
    spans,
    tracer: {
      startSpan(name, options) {
        const recorded: Recorded = {
          name,
          attributes: { ...options?.attributes },
          exceptions: [],
          ended: false,
        };
        spans.push(recorded);
        return {
          setAttribute(key, value) {
            recorded.attributes[key] = value;
          },
          recordException(error) {
            recorded.exceptions.push(typeof error === "string" ? error : error.message);
          },
          end() {
            recorded.ended = true;
          },
        };
      },
    },
  };
}

function registry(...definitions: RegisteredWorkflow[]): Map<string, RegisteredWorkflow> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

async function startAndClaim(
  client: Client,
  workflowName: string,
): Promise<ClaimedTask> {
  await startRun(client, { workflowName, workflowId: "cust-1" });
  const [task] = await claimTasks(client, { workerId: randomUUID() });
  return task!;
}

const named = (spans: Recorded[], name: string) =>
  spans.filter((span) => span.name === name);

describe("the Tracer interface", () => {
  // The whole bet of ADR-008 is that this interface costs nothing to satisfy
  // because it is a strict subset of OpenTelemetry's. If this assignment ever
  // stops compiling, an OTel user would need to write an adapter, and the
  // reason for choosing a hook over a dependency would be gone.
  it("accepts a tracer shaped like OpenTelemetry's, with no adapter", () => {
    interface OtelLikeSpan {
      setAttribute(
        key: string,
        value: string | number | boolean | string[],
      ): OtelLikeSpan;
      recordException(exception: Error | string, time?: number): void;
      setStatus(status: { code: number }): OtelLikeSpan;
      end(endTime?: number): void;
    }

    interface OtelLikeTracer {
      startSpan(
        name: string,
        options?: {
          attributes?: Record<string, string | number | boolean | string[]>;
        },
        context?: unknown,
      ): OtelLikeSpan;
      startActiveSpan<T>(name: string, fn: (span: OtelLikeSpan) => T): T;
    }

    const fromOtel = {} as OtelLikeTracer;
    const asCairnTracer: Tracer = fromOtel;

    expect(asCairnTracer).toBe(fromOtel);
  });
});

describe.skipIf(!hasDatabase)("tracing an execution", () => {
  it("traces the run and each of its steps", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { tracer, spans } = recordingTracer();
      const onboard = defineWorkflow<void, string>("onboard", async () => {
        await step("charge-card", () => "ch_1");
        await step("provision", () => "acct_1");
        return "done";
      });

      const task = await startAndClaim(client, "onboard");
      await executeTask({ client, workflows: registry(onboard), tracer }, task);

      const execute = named(spans, "cairn.execute");
      const steps = named(spans, "cairn.step");

      expect(execute).toHaveLength(1);
      expect(execute[0]!.attributes).toMatchObject({
        "cairn.run_id": task.runId,
        "cairn.queue": "default",
        "cairn.workflow": "onboard",
        "cairn.workflow_id": "cust-1",
        "cairn.outcome": "completed",
      });

      expect(steps.map((span) => span.attributes["cairn.step_key"])).toEqual([
        "charge-card#0",
        "provision#0",
      ]);
      expect(steps[0]!.attributes["cairn.step_attempt"]).toBe(1);
    });
  });

  it("records a step's failure on that step's span", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { tracer, spans } = recordingTracer();
      const broken = defineWorkflow<void, never>(
        "broken",
        async () => {
          await step("doomed", () => {
            throw new TypeError("card declined");
          });
          throw new Error("unreachable");
        },
        { retry: { maxAttempts: 1 } },
      );

      const task = await startAndClaim(client, "broken");
      await executeTask({ client, workflows: registry(broken), tracer }, task);

      const stepSpan = named(spans, "cairn.step")[0]!;
      expect(stepSpan.exceptions).toEqual(["card declined"]);
      expect(named(spans, "cairn.execute")[0]!.attributes["cairn.outcome"]).toBe(
        "failed",
      );
    });
  });

  // The step span covers `fn` only, precisely so the suspension paths — which
  // return a promise that never settles — cannot leave a span open forever.
  it("ends every span when the run suspends for a sleep", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { tracer, spans } = recordingTracer();
      const napping = defineWorkflow<void, void>("napping", async () => {
        await step("before", () => "b");
        await sleep("nap", "1 day");
        await step("after", () => "a");
      });

      const task = await startAndClaim(client, "napping");
      const outcome = await executeTask(
        { client, workflows: registry(napping), tracer },
        task,
      );

      expect(outcome.kind).toBe("sleeping");
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every((span) => span.ended)).toBe(true);
    });
  });

  it("ends every span when a retry suspends the run", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { tracer, spans } = recordingTracer();
      const flaky = defineWorkflow<void, string>(
        "flaky",
        async () =>
          step("call-api", () => {
            throw new Error("econnreset");
          }),
        { retry: { maxAttempts: 3, initialInterval: "1s", jitter: "none" } },
      );

      const task = await startAndClaim(client, "flaky");
      const outcome = await executeTask(
        { client, workflows: registry(flaky), tracer },
        task,
      );

      expect(outcome.kind).toBe("retrying");
      expect(spans.every((span) => span.ended)).toBe(true);
      expect(named(spans, "cairn.step")[0]!.exceptions).toEqual(["econnreset"]);
    });
  });

  it("does not trace steps replayed from the journal", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const once = defineWorkflow<void, string>("once", async () => {
        await step("first", () => "a");
        await sleep("nap", "1ms");
        return step("second", () => "b");
      });

      const task = await startAndClaim(client, "once");
      const deps = { client, workflows: registry(once) };

      await executeTask(deps, task);

      // Second attempt: `first` comes back from the journal, so only `second`
      // is real work and only `second` should produce a span.
      const { tracer, spans } = recordingTracer();
      await executeTask({ ...deps, tracer }, task);

      expect(named(spans, "cairn.step").map((s) => s.attributes["cairn.step_key"])).toEqual(
        ["second#0"],
      );
    });
  });

  it("runs untraced when no tracer is given", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const simple = defineWorkflow<void, string>("simple", async () =>
        step("a", () => "ok"),
      );

      const task = await startAndClaim(client, "simple");

      expect(await executeTask({ client, workflows: registry(simple) }, task)).toEqual({
        kind: "completed",
        output: "ok",
      });
    });
  });
});
