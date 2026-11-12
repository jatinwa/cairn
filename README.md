# cairn

Durable execution for applications that already have Postgres.

[![CI](https://github.com/jatinwa/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/jatinwa/cairn/actions/workflows/ci.yml)

> **Status: pre-alpha.**
> Workflows run, survive a crash at any point, and a worker polls for them. No published
> package and no API stability, and plenty from the design is still missing — cancellation,
> tracing, retention. The name is a placeholder pending an npm and trademark check.

---

## What this is

Multi-step business processes need to run to completion even though the processes executing
them crash, get deployed over, and run out of memory. `cairn` is a library that makes an
ordinary async function crash-proof: if the process dies partway through, execution resumes
on another worker, and steps that already completed are not run again.

Postgres is the only dependency. It runs as a library inside your own application process —
there is no cluster, broker or control plane to operate.

It is not a job queue. If you want high-throughput fire-and-forget work, use one; `cairn`
optimises for the correctness of *sequences*.

This runs today.

```ts
import { defineWorkflow, step, sleep } from "cairn";

export const onboard = defineWorkflow("onboard", async (ctx, input) => {
  const charge = await step("charge-card", () =>
    stripe.charges.create({
      amount: input.amount,
      idempotencyKey: ctx.idempotencyKey("charge-card"),
    }),
  );

  const account = await step("provision", () => provisionAccount(input.userId));
  await step("welcome-email", () => sendEmail(input.email, "welcome"));

  await sleep("trial-window", "14 days");

  const usage = await step("check-usage", () => getUsage(account.id));
  if (usage.activeDays < 3) {
    await step("downgrade", () => downgrade(account.id));
  }

  return { accountId: account.id, charged: charge.id };
});
```

Ordinary control flow. No sandbox, no forbidden APIs, no bundler step. `sleep("14 days")`
survives process death, deploys, and the fortnight in between.

To run it, start a worker and submit a job:

```ts
import { createWorker, startRun } from "cairn";

const worker = createWorker({ client, workflows: [onboard], concurrency: 4 });
worker.start();

await startRun(client, {
  workflowName: "onboard",
  workflowId: `signup:${user.id}`, // one open run per key, so a double click is one job
  input: { amount: 1999, userId: user.id, email: user.email },
});
```

A step may take far longer than the lease: the worker heartbeats it while it runs, because a
lease is there to notice a worker that **died**, not one that is slow. On shutdown,
`worker.stop()` stops claiming and waits for work in flight.

Give the worker a connection **pool**, not a single client. Heartbeats overlap the queries of
the task they are keeping alive, so a worker always has more than one query in flight even at
`concurrency: 1`.

## What it guarantees, stated plainly

**Steps execute at-least-once. Their recorded results are exactly-once.**

If a worker performs a step's side effect and then dies before recording the outcome, that
side effect will happen again on the retry. No durable execution engine can prevent this — it
is a property of talking to systems that can fail between "did the work" and "wrote it down".
What `cairn` guarantees is that a *completed and recorded* step is never re-executed, and that
the run always resumes from the right place.

Your step functions therefore need to be idempotent. `ctx.idempotencyKey(name)` gives you a
key derived from `(runId, stepName, occurrence)` — stable across retries, unique across runs —
to hand to any downstream service that supports one.

A run that cannot make progress reaches a terminal or parked state with a stated reason. It
does not silently retry forever.

## What's implemented

| Module | Provides |
|---|---|
| `duration.ts` | `parseDuration("14 days")` → milliseconds, for timers and retry policies |
| `keys.ts` | `stepKey(name, occurrence)` journal keys, and the `idempotencyKey` derived from them |
| `retry.ts` | Retry policy resolution, and `retryDelay()` with full jitter on by default |
| `errors.ts` | `NonRetryableError`, plus the library's own error types |
| `migrate.ts` | Applies the SQL schema — idempotent, and safe from several processes at once |
| `store.ts` | Starting runs, claiming tasks, leases and fences, closing and parking runs |
| `journal.ts` | The record of completed steps — read in one query, written once each |
| `workflow.ts` | `defineWorkflow`, and the `step()` and `sleep()` primitives |
| `execute.ts` | `executeTask`, which runs one claimed task to its next suspension point |
| `worker.ts` | `createWorker` — polling, heartbeating, concurrency, graceful shutdown |

The schema lives in `migrations/`, inside a dedicated `cairn` Postgres schema so it cannot
collide with your own `run`, `step` or `task` tables. Migrating takes any client with a
`query` method, so there is no runtime dependency on a particular driver:

```ts
import { Client } from "pg";
import { migrate } from "cairn";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await migrate(client); // safe to call on every boot
```

Still to come: cancellation, OpenTelemetry spans, continue-as-new for long journals, payload
offloading and the retention sweep, and a CLI.

## Development

Requirements: **Node >= 22.12**. Docker is optional — the database tests start a throwaway
Postgres via testcontainers when one is available and skip themselves when it is not. Set
`DATABASE_URL` to use a server you already have instead.

```bash
npm install
npm run typecheck
npm run lint
npm test
```

`npm run db:up` and `npm run db:down` start and stop a local Postgres on port 5433, if you
would rather not rely on testcontainers.

CI runs the whole suite on Node 22 and 24 against Postgres 15, 16 and 17, and fails if the
database tests skip — a green tick means they actually ran.

## Licence

MIT — see [LICENSE](LICENSE).
