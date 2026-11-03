-- cairn core schema.
--
-- Everything lives in a dedicated `cairn` schema rather than `public`. This
-- library is embedded in someone else's database, and `run`, `step` and `task`
-- are names an application is very likely to want for itself.
--
-- Three tables carry the whole model:
--   run   one execution of a workflow
--   step  its journal of work already done, keyed by name
--   task  the single unit of dispatchable work that moves the run forward

CREATE SCHEMA IF NOT EXISTS cairn;

CREATE TYPE cairn.run_status AS ENUM (
  'pending',    -- created, not yet picked up
  'running',    -- a worker holds a lease and is executing it
  'sleeping',   -- waiting for a durable timer to come due
  'completed',  -- finished successfully
  'failed',     -- finished with an error
  'cancelled',  -- stopped on request
  'continued'   -- ended to start a successor run (continue-as-new)
);

CREATE TYPE cairn.step_status AS ENUM ('running', 'completed', 'failed');

CREATE TABLE cairn.run (
  id             uuid              PRIMARY KEY,
  workflow_name  text              NOT NULL,
  -- Caller-supplied deduplication key. Two starts with the same pair while one
  -- is still open resolve to the same run; see run_open_per_workflow_id below.
  workflow_id    text              NOT NULL,
  status         cairn.run_status  NOT NULL DEFAULT 'pending',
  -- Payloads are stored inline when small and offloaded to object storage when
  -- not, in which case the *_ref column holds the pointer.
  input          jsonb,
  input_ref      text,
  output         jsonb,
  output_ref     text,
  error          jsonb,
  -- Set when a run cannot progress: 'unroutable', 'poison', and so on. The
  -- reason a run never just stops silently.
  stall_reason   text,
  -- Journal entries that no longer match any step the code reached.
  divergence     jsonb,
  journal_len    integer           NOT NULL DEFAULT 0,
  -- The run this one continued from, for continue-as-new chains.
  predecessor_id uuid              REFERENCES cairn.run (id),
  created_at     timestamptz       NOT NULL DEFAULT now(),
  closed_at      timestamptz,

  CONSTRAINT run_journal_len_non_negative CHECK (journal_len >= 0),
  CONSTRAINT run_input_storage_exclusive  CHECK (input  IS NULL OR input_ref  IS NULL),
  CONSTRAINT run_output_storage_exclusive CHECK (output IS NULL OR output_ref IS NULL),
  -- A closed run has a closing time and an open one does not. Keeping these in
  -- step removes a whole category of "finished but still listed as running".
  CONSTRAINT run_closed_at_matches_status CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'continued'))
      = (closed_at IS NOT NULL)
  )
);

-- At most one open run per (workflow_name, workflow_id). This single index is
-- the whole deduplication guarantee for starting workflows: two concurrent
-- starts race, one wins, the loser reads the winner's run. No locks involved.
CREATE UNIQUE INDEX run_open_per_workflow_id
  ON cairn.run (workflow_name, workflow_id)
  WHERE status IN ('pending', 'running', 'sleeping');

-- Supports retention sweeps, which delete closed runs in batches.
CREATE INDEX run_closed_at
  ON cairn.run (closed_at)
  WHERE closed_at IS NOT NULL;

CREATE TABLE cairn.step (
  run_id       uuid               NOT NULL REFERENCES cairn.run (id) ON DELETE CASCADE,
  -- 'charge-card#0' — the step name plus its occurrence index. Name-keyed, not
  -- positional, so a workflow can gain or reorder steps without invalidating
  -- the journal of a run already in flight.
  key          text               NOT NULL,
  status       cairn.step_status  NOT NULL,
  attempt      integer            NOT NULL DEFAULT 1,
  output       jsonb,
  output_ref   text,
  error        jsonb,
  started_at   timestamptz        NOT NULL DEFAULT now(),
  completed_at timestamptz,

  PRIMARY KEY (run_id, key),
  -- 256 for the name (MAX_STEP_NAME_LENGTH in src/keys.ts), plus the
  -- '#<occurrence>' suffix.
  CONSTRAINT step_key_length CHECK (char_length(key) BETWEEN 3 AND 280),
  CONSTRAINT step_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT step_output_storage_exclusive CHECK (output IS NULL OR output_ref IS NULL),
  CONSTRAINT step_completed_at_matches_status CHECK (
    (status IN ('completed', 'failed')) = (completed_at IS NOT NULL)
  )
);

CREATE TABLE cairn.task (
  id           bigserial   PRIMARY KEY,
  -- UNIQUE is load-bearing: at most one dispatchable task per run means a run
  -- can never execute on two workers at once. Per-run serialisation falls out
  -- of a unique constraint instead of a distributed lock.
  run_id       uuid        NOT NULL UNIQUE REFERENCES cairn.run (id) ON DELETE CASCADE,
  queue        text        NOT NULL DEFAULT 'default',
  -- One column serves three features: durable sleep, retry backoff, and
  -- delayed start are all "make this claimable later".
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt      integer     NOT NULL DEFAULT 0,
  priority     smallint    NOT NULL DEFAULT 0,
  lease_owner  uuid,
  lease_until  timestamptz,
  -- Bumped on every claim. Workers include it in their writes, so a worker
  -- whose lease expired while it was stalled cannot write stale state.
  fence        bigint      NOT NULL DEFAULT 0,

  CONSTRAINT task_attempt_non_negative CHECK (attempt >= 0),
  CONSTRAINT task_fence_non_negative CHECK (fence >= 0),
  CONSTRAINT task_lease_paired CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);

-- The hot path: unleased tasks that are due, in claim order.
CREATE INDEX task_claimable
  ON cairn.task (queue, priority DESC, available_at)
  WHERE lease_owner IS NULL;

-- The recovery path: finding tasks whose lease has expired. `now()` is not
-- immutable so it cannot appear in an index predicate, which is why this is a
-- second index rather than part of the one above.
CREATE INDEX task_leased
  ON cairn.task (lease_until)
  WHERE lease_owner IS NOT NULL;
