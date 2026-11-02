import { InvalidDurationError } from "./errors.js";

/**
 * A duration, either as a number of milliseconds or a human-readable string
 * such as `"14 days"`, `"30s"` or `"1h30m"`.
 */
export type Duration = number | string;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,

  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,

  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,

  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,

  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,

  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/**
 * Units we deliberately refuse. A month is 28–31 days and a year is 365 or 366,
 * so a durable timer expressed in them is ambiguous by exactly the amount that
 * matters to a billing cycle. Callers must say what they mean in days.
 */
const AMBIGUOUS_UNITS = new Set([
  "mo",
  "month",
  "months",
  "y",
  "yr",
  "yrs",
  "year",
  "years",
]);

/** `12`, `1.5h`, `30 s`, `1h30m` — one or more amount+unit terms. */
const WELL_FORMED = /^(?:[0-9]+(?:\.[0-9]+)?\s*[a-z]+\s*)+$/;
const TERM = /([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)/g;

/**
 * Parse a {@link Duration} into whole milliseconds.
 *
 * Terms accumulate, so `"1h30m"` is 5,400,000. Numbers are taken as
 * milliseconds already and pass through unchanged.
 *
 * @throws {InvalidDurationError} if the input is malformed, negative, or uses a
 *   unit whose length varies (months, years).
 */
export function parseDuration(input: Duration): number {
  if (typeof input === "number") {
    return assertValidMilliseconds(input, String(input));
  }

  const text = input.trim().toLowerCase();
  if (text === "") {
    throw new InvalidDurationError(input, "it is empty");
  }
  if (!WELL_FORMED.test(text)) {
    throw new InvalidDurationError(
      input,
      'expected one or more amount and unit pairs, such as "30s" or "1h30m"',
    );
  }

  let total = 0;
  TERM.lastIndex = 0;
  for (let match = TERM.exec(text); match !== null; match = TERM.exec(text)) {
    // WELL_FORMED guarantees both groups are present.
    const amount = Number(match[1]);
    const unit = match[2]!;

    if (AMBIGUOUS_UNITS.has(unit)) {
      throw new InvalidDurationError(
        input,
        `the unit "${unit}" varies in length, so express it in days instead`,
      );
    }

    const scale = UNIT_MS[unit];
    if (scale === undefined) {
      throw new InvalidDurationError(input, `the unit "${unit}" is not recognised`);
    }

    total += amount * scale;
  }

  return assertValidMilliseconds(total, input);
}

function assertValidMilliseconds(value: number, input: string): number {
  if (!Number.isFinite(value)) {
    throw new InvalidDurationError(input, "it is not a finite number");
  }
  if (value < 0) {
    throw new InvalidDurationError(input, "it is negative");
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new InvalidDurationError(input, "it exceeds the largest safe integer");
  }
  return Math.round(value);
}
