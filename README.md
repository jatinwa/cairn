# cairn

Durable execution for applications that already have Postgres.

> **Status: pre-alpha. Nothing works yet.**
> This repository currently contains design documents and a build toolchain. There is no
> runtime, no published package, and no API stability. The name is a placeholder pending an
> npm and trademark check.

---

## What this is

Multi-step business processes need to run to completion even though the processes executing
them crash, get deployed over, and run out of memory. `cairn` is a library that makes an
ordinary async function crash-proof: if the process dies partway through, execution resumes
on another worker, and steps that already completed are not run again.

The target API, for reference — **this does not run today**:

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

## What it guarantees, stated plainly

**Steps execute at-least-once. Their recorded results are exactly-once.**

If a worker performs a step's side effect and then dies before recording the outcome, that
side effect will happen again on the retry. No durable execution engine can prevent this,
including Temporal — it is a property of talking to systems that can fail between "did the
work" and "wrote it down". What `cairn` guarantees is that a *completed and recorded* step is
never re-executed, and that the run always resumes from the right place.

Your step functions therefore need to be idempotent. `ctx.idempotencyKey(name)` gives you a
key derived from `(runId, stepName, occurrence)` — stable across retries, unique across runs —
to hand to any downstream service that supports one.

A run that cannot make progress reaches a terminal or parked state with a stated reason. It
does not silently retry forever.

## Where this sits

| | |
|---|---|
| **Dependencies** | Postgres. That's the whole list |
| **Deployment** | A library in your app's process. A standalone worker is an option, not a requirement |
| **Durability model** | A name-keyed step journal, not replay-determinism — so inserting, reordering or deleting a step does not break in-flight runs |
| **Not for** | Fire-and-forget throughput. Use a job queue. This optimises for correctness of *sequences* |

If you need multi-region replication, cross-language SDKs, or a hosted control plane, use
[Temporal](https://temporal.io). It is excellent and this is not a replacement for it.

## Design documents

The design is written down before the code, and is worth reading first:

- [`docs/01-temporal-research.md`](docs/01-temporal-research.md) — how Temporal actually
  works: the replay mechanic, its internal architecture, hard limits, and the determinism and
  versioning costs that motivate the design choices here.
- [`docs/02-design.md`](docs/02-design.md) — the programming model, Postgres schema,
  claim/lease/fence engine, capacity targets and SLOs, failure-mode table, test strategy, and
  the decision record.

## Development

Requirements: **Node >= 20.11**, and **Docker** for the integration tests (they start a
throwaway Postgres via testcontainers; set `DATABASE_URL` to point at an existing server
instead).

```bash
npm install
npm run typecheck
npm run lint
npm test
```

| Script | Does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm run lint` | ESLint, type-aware |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run db:up` / `db:down` | A local Postgres container on port 5433, for poking at by hand |

## Licence

Apache-2.0.
