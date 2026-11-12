export { executeTask, type ExecuteDeps, type ExecutionOutcome } from "./execute.js";

export {
  createWorker,
  waitForRun,
  type StopOptions,
  type Worker,
  type WorkerEvent,
  type WorkerOptions,
} from "./worker.js";

export {
  defineWorkflow,
  sleep,
  step,
  type RegisteredWorkflow,
  type StepOptions,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowFunction,
} from "./workflow.js";

export {
  CairnError,
  EngineError,
  InvalidArgumentError,
  InvalidDurationError,
  InvalidRetryPolicyError,
  InvalidStepNameError,
  MigrationChecksumError,
  MigrationError,
  NonRetryableError,
  serialiseError,
  type SerialisedError,
} from "./errors.js";

export {
  beginStep,
  completeStep,
  failStep,
  readJournal,
  type BeginStepOptions,
  type CompleteStepOptions,
  type FailStepOptions,
  type Journal,
  type JournalEntry,
  type StepStatus,
} from "./journal.js";

export { OPEN_STATUSES_SQL, SCHEMA_NAME, type SqlExecutor } from "./sql.js";

export {
  checksumOf,
  loadMigrations,
  migrate,
  type MigrateResult,
  type Migration,
} from "./migrate.js";

export {
  claimTasks,
  closeRun,
  deleteTask,
  getRun,
  heartbeatTask,
  markRunRunning,
  parkRun,
  releaseTask,
  startRun,
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LEASE,
  type ClaimOptions,
  type ClaimedTask,
  type CloseRunOptions,
  type ClosedRunStatus,
  type ReleaseOptions,
  type RunRecord,
  type RunStatus,
  type StartRunOptions,
  type StartRunResult,
  type TaskLease,
} from "./store.js";

export { parseDuration, type Duration } from "./duration.js";

export {
  assertStepName,
  idempotencyKey,
  stepKey,
  MAX_STEP_NAME_LENGTH,
  STEP_KEY_SEPARATOR,
} from "./keys.js";

export {
  DEFAULT_RETRY_POLICY,
  errorType,
  isRetryable,
  resolveRetryPolicy,
  retryDelay,
  shouldRetry,
  type JitterMode,
  type ResolvedRetryPolicy,
  type RetryPolicy,
} from "./retry.js";
