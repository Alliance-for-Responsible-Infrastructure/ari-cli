/**
 * Pure helpers for the `ari pipeline` commands: exit codes, the error type
 * that carries one, duration parsing/formatting, AWS error classification,
 * and the allow-listed fold of Step Functions execution history.
 *
 * Nothing in here touches AWS, the filesystem, or the terminal, so it is
 * unit-tested directly. In particular `foldHistory` is the *only* place raw
 * execution-history events are read, and it copies a fixed allow-list of
 * fields out of them (never `input`, `output`, or — by default — `cause`).
 */

export const EXIT = {
    OK: 0,
    ERROR: 1,
    USAGE: 2,
    WAIT_TIMEOUT: 3,
    CREDENTIALS_EXPIRED: 4,
    FAILED: 10,
    TIMED_OUT: 11,
    ABORTED: 12,
    INTERRUPTED: 130,
};

/** Terminal execution status -> process exit code. */
export const STATUS_EXIT = {
    SUCCEEDED: EXIT.OK,
    FAILED: EXIT.FAILED,
    TIMED_OUT: EXIT.TIMED_OUT,
    ABORTED: EXIT.ABORTED,
};

export const TERMINAL_STATUSES = Object.keys(STATUS_EXIT);

/** An Error that carries the process exit code `runCommand` should use. */
export class PipelineError extends Error {
    constructor(message, exitCode = EXIT.ERROR) {
        super(message);
        this.name = 'PipelineError';
        this.exitCode = exitCode;
    }
}

/**
 * Parses `90s` / `15m` / `2h` (a bare number is seconds) into seconds.
 * `none`/undefined means "no limit" and returns null.
 * @param {string|number|undefined} value
 * @returns {number|null}
 */
export function parseDuration(value) {
    if (value === undefined || value === null || value === 'none') {
        return null;
    }
    const match = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
    if (!match || Number(match[1]) <= 0) {
        throw new PipelineError(
            `Invalid duration "${value}" — use a positive number with an s, m, h or d suffix (e.g. 90s, 15m, 2h) or "none".`,
            EXIT.USAGE,
        );
    }
    const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
    return Number(match[1]) * unit;
}

/** Formats seconds as `1.2s`, `41s`, `6m 29s`, `1h 02m`. */
export function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
        return '-';
    }
    if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** `HH:MM:SS` elapsed clock for progress lines. */
export function formatElapsed(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

const EXPIRED_CREDENTIAL_ERRORS = new Set([
    'ExpiredTokenException',
    'ExpiredToken',
    'UnrecognizedClientException',
    'InvalidClientTokenId',
]);

const TRANSIENT_ERRORS = new Set([
    'ThrottlingException',
    'Throttling',
    'TooManyRequestsException',
    'RequestLimitExceeded',
    'ServiceUnavailable',
    'InternalFailure',
    'InternalServerError',
    'TimeoutError',
    'RequestTimeout',
]);

const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EPIPE',
    'ENETUNREACH',
]);

/** True for errors meaning the cached credentials are no longer valid. */
export function isExpiredCreds(e) {
    return (
        EXPIRED_CREDENTIAL_ERRORS.has(e?.name) ||
        EXPIRED_CREDENTIAL_ERRORS.has(e?.Code)
    );
}

/** True for throttling / 5xx / network errors worth retrying with backoff. */
export function isTransient(e) {
    if (!e || isExpiredCreds(e)) return false;
    if (TRANSIENT_ERRORS.has(e.name) || TRANSIENT_ERRORS.has(e.Code)) {
        return true;
    }
    if (TRANSIENT_NETWORK_CODES.has(e.code)) return true;
    if (e.$retryable) return true;
    const status = e.$metadata?.httpStatusCode;
    return typeof status === 'number' && status >= 500;
}

/** Truncates a log/cause string to `max` chars with an ellipsis marker. */
export function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

const toSeconds = (a, b) => (new Date(b) - new Date(a)) / 1000;

const ENTERED = /^(\w+)StateEntered$/;
const SCHEDULED = new Set(['TaskScheduled', 'LambdaFunctionScheduled']);
const FAILURES = {
    TaskFailed: 'taskFailedEventDetails',
    LambdaFunctionFailed: 'lambdaFunctionFailedEventDetails',
    TaskTimedOut: 'taskTimedOutEventDetails',
    LambdaFunctionTimedOut: 'lambdaFunctionTimedOutEventDetails',
};

/**
 * Folds raw `GetExecutionHistory` events into one row per state (nested Map
 * iteration states are aggregated under their Map, not listed per item).
 *
 * ALLOW-LIST: the only values read from events are the event type,
 * timestamp, id/previousEventId, state names (`stateEnteredEventDetails.name`
 * — config-defined step ids), the Map `length`, Map iteration counts, and
 * the `error` code of failure events. `input`, `output` and Map item values
 * are never read. `cause` is read only when `includeCause` is true, and is
 * truncated to 300 chars.
 *
 * @param {Array<Object>} events - all pages of events, oldest first
 * @param {{includeCause?: boolean}} [opts]
 * @returns {{states: Array<Object>, execution: Object}}
 */
export function foldHistory(events, { includeCause = false } = {}) {
    const byId = new Map(events.map((e) => [e.id, e]));
    const states = []; // StateEntered events' rows, in order
    const rowByEnteredId = new Map();
    const parentMemo = new Map();

    const isEntered = (e) => ENTERED.test(e.type);
    const isBranchStart = (e) =>
        e.type === 'MapIterationStarted' ||
        e.type === 'ParallelStateStarted' ||
        e.type === 'MapStateStarted';

    // Nearest StateEntered at-or-before this event on its previousEventId
    // chain, and whether the walk crossed a Map iteration boundary.
    const walkToState = (event) => {
        let crossed = false;
        let cur = event;
        while (cur) {
            if (isEntered(cur)) return { entered: cur, crossed };
            if (cur.type === 'MapIterationStarted') crossed = true;
            cur = byId.get(cur.previousEventId);
        }
        return { entered: null, crossed };
    };

    // The Map state (StateEntered event) that owns a nested state, or null.
    const parentOf = (entered) => {
        if (parentMemo.has(entered.id)) return parentMemo.get(entered.id);
        let result = null;
        const prev = byId.get(entered.previousEventId);
        if (prev) {
            const { entered: up, crossed } = walkToState(prev);
            if (up) result = crossed ? up : parentOf(up);
        }
        parentMemo.set(entered.id, result);
        return result;
    };

    for (const e of events) {
        const m = ENTERED.exec(e.type);
        if (!m) continue;
        const row = {
            name: e.stateEnteredEventDetails?.name ?? '?',
            type: m[1],
            enteredAt: e.timestamp,
            exitedAt: null,
            durationSec: null,
            attempts: 0,
            failures: 0,
            error: null,
            result: 'RUNNING',
            nested: false,
            parent: null,
            _entered: e,
        };
        if (includeCause) row.cause = null;
        rowByEnteredId.set(e.id, row);
        states.push(row);
    }

    for (const row of states) {
        const p = parentOf(row._entered);
        if (p) {
            row.nested = true;
            row.parent = rowByEnteredId.get(p.id)?.name ?? null;
        }
    }

    for (const e of events) {
        const exit = /^(\w+)StateExited$/.exec(e.type);
        if (exit) {
            const { entered } = walkToState(e);
            const row = entered && rowByEnteredId.get(entered.id);
            if (row) {
                row.exitedAt = e.timestamp;
                row.durationSec = toSeconds(row.enteredAt, e.timestamp);
                row.result = 'ok';
            }
            continue;
        }

        if (e.type === 'MapStateStarted' || e.type.startsWith('MapIteration')) {
            let row;
            const mapName =
                e.mapIterationStartedEventDetails?.name ??
                e.mapIterationSucceededEventDetails?.name ??
                e.mapIterationFailedEventDetails?.name ??
                e.mapIterationAbortedEventDetails?.name;
            if (e.type === 'MapStateStarted') {
                const { entered } = walkToState(e);
                row = entered && rowByEnteredId.get(entered.id);
            } else {
                // Iteration events carry the Map state's name; their
                // previousEventId chain leads into the nested states.
                row = [...states]
                    .reverse()
                    .find((r) => r.type === 'Map' && r.name === mapName);
            }
            if (!row) continue;
            if (e.type === 'MapStateStarted') {
                row.items = e.mapStateStartedEventDetails?.length ?? null;
            } else if (e.type === 'MapIterationStarted') {
                row.iterationsStarted = (row.iterationsStarted ?? 0) + 1;
            } else if (e.type === 'MapIterationSucceeded') {
                row.iterationsOk = (row.iterationsOk ?? 0) + 1;
            } else if (
                e.type === 'MapIterationFailed' ||
                e.type === 'MapIterationAborted'
            ) {
                row.iterationsFailed = (row.iterationsFailed ?? 0) + 1;
            }
            continue;
        }

        if (SCHEDULED.has(e.type) || FAILURES[e.type]) {
            const { entered } = walkToState(e);
            const row = entered && rowByEnteredId.get(entered.id);
            if (!row) continue;
            if (SCHEDULED.has(e.type)) {
                row.attempts += 1;
            } else {
                row.failures += 1;
                const details = e[FAILURES[e.type]] ?? {};
                row.error = details.error ?? e.type;
                if (includeCause && details.cause) {
                    row.cause = truncate(details.cause, 300);
                }
            }
        }
    }

    // A state with a failure event but no exit event never completed.
    for (const row of states) {
        if (row.result !== 'ok' && row.failures > 0) row.result = 'FAILED';
        if (row.type === 'Map' && row.iterationsFailed > 0) {
            row.result = row.exitedAt ? 'ok' : 'FAILED';
        }
    }

    const execution = { status: 'RUNNING', error: null };
    for (const e of events) {
        if (e.type === 'ExecutionSucceeded') execution.status = 'SUCCEEDED';
        else if (e.type === 'ExecutionFailed') {
            execution.status = 'FAILED';
            execution.error = e.executionFailedEventDetails?.error ?? null;
            if (includeCause && e.executionFailedEventDetails?.cause) {
                execution.cause = truncate(
                    e.executionFailedEventDetails.cause,
                    300,
                );
            }
        } else if (e.type === 'ExecutionAborted') execution.status = 'ABORTED';
        else if (e.type === 'ExecutionTimedOut') {
            execution.status = 'TIMED_OUT';
        }
    }

    // Aggregate nested rows into their parent Map: one summary per nested
    // state name, never one row per item.
    const topLevel = [];
    const nestedByKey = new Map();
    for (const row of states) {
        if (!row.nested) {
            topLevel.push(row);
            continue;
        }
        const key = `${row.parent}\u0000${row.name}`;
        let agg = nestedByKey.get(key);
        if (!agg) {
            agg = {
                name: row.name,
                type: row.type,
                parent: row.parent,
                nested: true,
                entries: 0,
                attempts: 0,
                failures: 0,
                error: null,
                totalDurationSec: 0,
                completed: 0,
                failedEntries: 0,
            };
            nestedByKey.set(key, agg);
            topLevel.push(agg);
        }
        agg.entries += 1;
        agg.attempts += row.attempts;
        agg.failures += row.failures;
        if (row.result === 'FAILED') agg.failedEntries += 1;
        if (row.error) agg.error = row.error;
        if (row.durationSec !== null) {
            agg.totalDurationSec += row.durationSec;
            agg.completed += 1;
        }
    }

    const out = [];
    for (const row of topLevel) {
        if (row.nested) {
            out.push({
                name: row.name,
                type: row.type,
                parent: row.parent,
                nested: true,
                calls: row.attempts || row.entries,
                avgDurationSec: row.completed
                    ? row.totalDurationSec / row.completed
                    : null,
                retried: Math.max(0, row.attempts - row.entries),
                failures: row.failures,
                error: row.error,
                result: row.failedEntries > 0 ? 'FAILED' : 'ok',
            });
        } else {
            const { _entered, ...clean } = row;
            out.push(clean);
        }
    }

    return { states: out, execution };
}

/** Local `HH:MM:SS` for a Date / epoch ms / ISO string. */
export function formatClock(value) {
    const d = new Date(value);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Renders one Step Functions CloudWatch log event as a single line.
 *
 * ALLOW-LIST: the message is parsed and only `type`, the state name
 * (`details.name`) and the `details.error` code are printed — never
 * `details.input`/`output`/`cause` or anything else. (With
 * includeExecutionData off those are absent anyway; this keeps the CLI
 * safe if a pipeline turns it on.) A line that isn't JSON is printed raw,
 * truncated to 500 chars unless `full`.
 *
 * @param {{timestamp: number, message: string}} event
 * @param {{full?: boolean}} [opts]
 */
export function formatSfnLogEvent(event, { full = false } = {}) {
    const clock = formatClock(event.timestamp);
    let parsed;
    try {
        parsed = JSON.parse(event.message);
    } catch {
        const raw = String(event.message ?? '').trim();
        return `${clock} sfn ${full ? raw : truncate(raw, 500)}`;
    }
    const parts = [parsed.type ?? 'Unknown'];
    if (parsed.details?.name) parts.push(parsed.details.name);
    if (parsed.details?.error) parts.push(`error=${parsed.details.error}`);
    const line = parts.join(' ');
    return `${clock} sfn ${full ? line : truncate(line, 500)}`;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// Node.js runtime text format: "<ISO timestamp>\t<requestId>\t<LEVEL>\t<body>"
const RUNTIME_PREFIX = new RegExp(
    `^\\S+\\t${UUID}\\t(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\\t`,
);
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,100}$/;
const WITHHELD = '[line withheld: not a recognized fixed-format line]';

/** Pulls `Label: <number> unit` out of a Lambda REPORT line; null if absent. */
function reportNumber(body, label) {
    const m = new RegExp(`(?:^|\\t)${label}: ([0-9]+(?:\\.[0-9]+)?) (ms|MB)`).exec(body);
    return m ? `${m[1]}${m[2] === 'ms' ? 'ms' : ''}` : null;
}

/**
 * Classifies and renders one Lambda log event, ALLOW-LIST ONLY. Returns
 * `null` for a line that belongs to a different run (dropped), otherwise a
 * `{ text }` where text is built solely from fields this function extracts
 * itself — the raw message is never echoed. Recognized shapes:
 *
 *  - the pipeline's EMF metric line (JSON with `_aws`): printed as
 *    `METRIC step=<stepId> duration=<n>ms`, only if its `runId` equals the
 *    requested run (so other concurrent runs are filtered out). `fileId`
 *    (derived from source file names) is deliberately not printed.
 *  - Lambda platform lines `START` / `END` / `REPORT` (REPORT: duration,
 *    billed duration, memory, init duration — numbers only). These carry a
 *    request id, not a run id, so they are shown by time window.
 *  - `Task timed out after N seconds` and `Runtime exited with error: signal: X`.
 *  - the runtime's `Invoke Error {"errorType": ...}` line: only the
 *    `errorType` token (handlers throw a fixed error code), never
 *    `errorMessage` or the stack.
 *
 * Anything else (including any free-text `console.*` line a future handler
 * might add) is replaced by a fixed "withheld" marker, so a log line that
 * could contain protected content can never reach the terminal.
 *
 * @param {{timestamp: number, message: string}} event
 * @param {{runId: string}} opts
 * @returns {{text: string}|null}
 */
export function classifyLambdaLogEvent(event, { runId }) {
    const message = String(event.message ?? '').trim();
    const prefixMatch = RUNTIME_PREFIX.exec(message);
    const body = (prefixMatch ? message.slice(prefixMatch[0].length) : message).trim();

    if (new RegExp(`^START RequestId: ${UUID}(?: Version: \\S+)?$`).test(body)) {
        return { text: 'START' };
    }
    if (new RegExp(`^END RequestId: ${UUID}$`).test(body)) {
        return { text: 'END' };
    }
    if (new RegExp(`^REPORT RequestId: ${UUID}\\s`).test(body)) {
        const parts = ['REPORT'];
        const duration = reportNumber(body, 'Duration');
        const billed = reportNumber(body, 'Billed Duration');
        const init = reportNumber(body, 'Init Duration');
        const size = /Memory Size: ([0-9]+) MB/.exec(body);
        const used = /Max Memory Used: ([0-9]+) MB/.exec(body);
        if (duration) parts.push(`duration=${duration}`);
        if (billed) parts.push(`billed=${billed}`);
        if (used && size) parts.push(`memory=${used[1]}/${size[1]}MB`);
        if (init) parts.push(`init=${init}`);
        return { text: parts.join(' ') };
    }
    const timeout = /^(?:\S+\s+)?(?:\S+\s+)?Task timed out after ([0-9]+(?:\.[0-9]+)?) seconds$/.exec(body);
    if (timeout) return { text: `TIMEOUT after ${timeout[1]}s` };
    const exited = new RegExp(
        `^(?:RequestId: ${UUID} )?Error: Runtime exited with error: signal: ([a-z]{3,20})$`,
    ).exec(body);
    if (exited) return { text: `RUNTIME_EXIT signal=${exited[1]}` };

    const jsonText = /^Invoke Error\s+(\{[\s\S]*\})$/.exec(body)?.[1] ?? body;
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return { text: WITHHELD };
    }
    if (parsed && typeof parsed === 'object' && parsed._aws && typeof parsed._aws === 'object') {
        if (parsed.runId !== runId) return null;
        const step = SAFE_TOKEN.test(String(parsed.stepId)) ? parsed.stepId : '?';
        const parts = ['METRIC', `step=${step}`];
        if (Number.isFinite(parsed.StepDuration)) {
            parts.push(`duration=${Math.round(parsed.StepDuration)}ms`);
        }
        return { text: parts.join(' ') };
    }
    if (parsed && typeof parsed === 'object' && 'errorType' in parsed) {
        const type = SAFE_TOKEN.test(String(parsed.errorType)) ? parsed.errorType : '(unrecognized type)';
        return { text: `ERROR ${type}` };
    }
    return { text: WITHHELD };
}

/**
 * Short per-group labels for the source column: `/aws/lambda/` stripped and,
 * with more than one group, the common name prefix (up to the last shared "-") removed.
 * @param {string[]} groupNames
 * @returns {Object<string,string>} group name -> label
 */
export function lambdaLabels(groupNames) {
    const stripped = groupNames.map((g) => g.replace(/^\/aws\/lambda\//, ''));
    let prefix = '';
    if (stripped.length > 1) {
        const [first] = stripped;
        let i = 0;
        while (i < first.length && stripped.every((s) => s[i] === first[i])) i++;
        // snap back to a word boundary: function names are clamped to 64 chars by
        // shaving the project name, so the raw common prefix can end mid-word
        prefix = first.slice(0, first.slice(0, i).lastIndexOf('-') + 1);
    }
    return Object.fromEntries(
        groupNames.map((g, i) => [g, stripped[i].slice(prefix.length) || stripped[i]]),
    );
}

/** `HH:MM:SS lambda:<label> <text>` for a classified Lambda event. */
export function formatLambdaLogLine(event, label, text, { full = false } = {}) {
    const line = `${formatClock(event.timestamp)} lambda:${label} ${text}`;
    return full ? line : truncate(line, 500);
}
