-- Cancellation is cooperative.
--
-- A request is recorded here; the worker holding the run notices it and unwinds.
-- Closing the run stays the worker's decision, so a run is never marked
-- cancelled while one of its steps is still mid-flight. Only a run nobody is
-- working on is closed immediately, by the request itself.

ALTER TABLE cairn.run
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_reason       text;

-- Finding runs that should stop. Partial because cancellation is rare and the
-- index should stay small.
CREATE INDEX run_cancel_requested
  ON cairn.run (cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL AND closed_at IS NULL;
