import crypto from 'crypto';
import nodeFs from 'fs';
import path from 'path';

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
    S3Client,
    ListObjectsV2Command,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
    SFNClient,
    StartExecutionCommand,
    DescribeExecutionCommand,
    DescribeStateMachineCommand,
    ListExecutionsCommand,
    StopExecutionCommand,
    GetExecutionHistoryCommand,
} from '@aws-sdk/client-sfn';
import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

import {
    EXIT,
    PipelineError,
    STATUS_EXIT,
    TERMINAL_STATUSES,
    classifyLambdaLogEvent,
    formatLambdaLogLine,
    formatSfnLogEvent,
    isExpiredCreds,
    isTransient,
    lambdaLabels,
} from '#src/lib/cli/pipeline-utils.js';
import {
    keyFor,
    prefixFor,
    validateDataManifest,
} from '#src/lib/cli/manifest.js';
import { writeProtectedFile } from '#src/lib/cli/content-gate.js';
import { readLocalConfig } from '#src/lib/local-config.js';

export const DEFAULT_PIPELINE_REGION = 'us-east-1';

/**
 * Real implementations of everything the functions below need from the
 * outside world. Every exported function accepts an optional `deps` object
 * that overrides any of these, so tests inject fakes (clients, a fake
 * clock/sleep, a SIGINT hook) instead of mocking the AWS SDK modules.
 * Clients are *factories*: waiting/following rebuilds a client after a
 * credential expiry, which re-reads ~/.aws/credentials.
 */
export function defaultDeps(region = DEFAULT_PIPELINE_REGION) {
    return {
        createSsm: () => new SSMClient({ region }),
        createSts: () => new STSClient({ region }),
        createSfn: () => new SFNClient({ region }),
        createLogs: () => new CloudWatchLogsClient({ region }),
        createS3: () => new S3Client({ region }),
        readLocalConfig,
        fs: nodeFs,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        random: Math.random,
        onSigint: (handler) => {
            process.on('SIGINT', handler);
            return () => process.off('SIGINT', handler);
        },
        exit: (code) => process.exit(code),
        logErr: (...args) => console.error(...args),
    };
}

const withDeps = (region, deps) => ({ ...defaultDeps(region), ...deps });

/**
 * The named-pipeline registry path convention every pipeline's own
 * `ari-iac`-built stack declares as an SSM StringParameter (see
 * ari-cli/references/project-notes.md, "Revised again: one codebase per
 * pipeline" — no master DDB table, the parameter is part of the stack's
 * own declarative definition).
 * @param {string} name - a pipeline's projectName, e.g. "dev-bedrock-docs"
 */
function registryParameterName(name) {
    return `/ari/pipelines/${name}/stateMachineArn`;
}

function manifestParameterName(name) {
    return `/ari/pipelines/${name}/manifest`;
}

/**
 * Reads and parses the manifest parameter (schema 1 enforced). A pipeline
 * deployed before the registry existed has none: that is a clear error, not a
 * fallback to guessing names.
 */
async function readManifestParameter(name, region, deps, useHint) {
    const ssm = withDeps(region, deps).createSsm();
    let value;
    try {
        const { Parameter } = await ssm.send(
            new GetParameterCommand({ Name: manifestParameterName(name) }),
        );
        value = Parameter.Value;
    } catch (e) {
        if (e.name === 'ParameterNotFound') {
            throw new PipelineError(
                `"${name}" has no manifest (no parameter at "${manifestParameterName(name)}"). ` +
                    "The pipeline has not been redeployed with ari-iac's PipelineRegistry yet; " +
                    `redeploy it (ari pipeline deploy) to use ${useHint}.`,
            );
        }
        throw e;
    }
    let manifest;
    try {
        manifest = JSON.parse(value);
    } catch {
        throw new PipelineError(
            `The manifest for "${name}" is not valid JSON; redeploy the pipeline.`,
        );
    }
    if (manifest?.schema !== 1) {
        throw new PipelineError(
            `The manifest for "${name}" has schema ${JSON.stringify(manifest?.schema)}, but this ari-cli only understands schema 1. Update ari-cli.`,
        );
    }
    return manifest;
}

/**
 * Reads the pipeline's operator manifest (written by ari-iac's
 * PipelineRegistry) from `/ari/pipelines/<name>/manifest` for `logs`.
 *
 * @returns {Promise<Object>} the parsed manifest (schema 1)
 */
export async function getPipelineManifest(
    name,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const manifest = await readManifestParameter(
        name,
        region,
        deps,
        '"--source lambda"/"--source all" ("--source sfn" works without it)',
    );
    const lambdaGroups = manifest.logGroups?.lambda;
    if (
        !Array.isArray(lambdaGroups) ||
        lambdaGroups.length === 0 ||
        !lambdaGroups.every((g) => typeof g === 'string' && g.length > 0)
    ) {
        throw new PipelineError(
            `The manifest for "${name}" lists no Lambda log groups (logGroups.lambda); redeploy the pipeline.`,
        );
    }
    return manifest;
}

/**
 * Resolves a named pipeline's state machine ARN from its registry SSM
 * parameter. Deliberately knows nothing about any pipeline's own workers,
 * stages, or data — just this one fixed path convention, using whatever
 * AWS credentials `ari credentials` has already activated.
 *
 * @param {string} name
 * @param {string} [region]
 * @returns {Promise<string>}
 */
export async function resolveStateMachineArn(
    name,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const ssm = withDeps(region, deps).createSsm();
    try {
        const { Parameter } = await ssm.send(
            new GetParameterCommand({ Name: registryParameterName(name) }),
        );
        return Parameter.Value;
    } catch (e) {
        if (e.name === 'ParameterNotFound') {
            throw new Error(
                `No pipeline named "${name}" found in ${region} (no parameter at "${registryParameterName(name)}"). ` +
                    'Check the name, the --region, and that the pipeline has actually been deployed.',
            );
        }
        throw e;
    }
}

/**
 * Generates a run id: short, sortable, human-typeable. Used both as the
 * Step Functions execution's own name and as the `{ runId }` execution
 * input every pipeline's state machine expects (see ari-iac's
 * PipelineStateMachine) — using it as the execution name too is what lets
 * `executionArnFor` derive an execution's ARN later without listing/
 * searching executions.
 * @returns {string}
 */
export function generateRunId() {
    const timestamp = new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14);
    const suffix = crypto.randomBytes(3).toString('hex');
    return `run-${timestamp}-${suffix}`;
}

/**
 * Starts a pipeline execution.
 *
 * @param {string} stateMachineArn
 * @param {string} runId
 * @param {string} [region]
 * @returns {Promise<{executionArn: string, startDate: Date}>}
 */
export async function startPipelineRun(
    stateMachineArn,
    runId,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    try {
        const { executionArn, startDate } = await sfn.send(
            new StartExecutionCommand({
                stateMachineArn,
                name: runId,
                input: JSON.stringify({ runId }),
            }),
        );
        return { executionArn, startDate };
    } catch (e) {
        if (e.name === 'ExecutionAlreadyExists') {
            throw new PipelineError(
                `A run named "${runId}" already exists on this pipeline (Step Functions execution names are unique for 90 days, even for FAILED or ABORTED runs). ` +
                    `Pick another id, e.g. --run-id ${runId}-2 (and load any data under that id first).`,
            );
        }
        throw e;
    }
}

/**
 * Derives a Step Functions execution ARN from a state machine ARN + runId.
 * Relies on startPipelineRun always using runId as the execution's own
 * name: arn:aws:states:REGION:ACCOUNT:stateMachine:NAME becomes
 * arn:aws:states:REGION:ACCOUNT:execution:NAME:runId.
 *
 * @param {string} stateMachineArn
 * @param {string} runId
 * @returns {string}
 */
export function executionArnFor(stateMachineArn, runId) {
    const [, , , region, account, , name] = stateMachineArn.split(':');
    return `arn:aws:states:${region}:${account}:execution:${name}:${runId}`;
}

/**
 * Looks up a pipeline run's status by describing its Step Functions
 * execution directly. Deliberately doesn't query any pipeline's own
 * DynamoDB status table — that would require knowing that pipeline's own
 * schema (parse_status/verify_status/...), which is exactly the
 * pipeline-specific knowledge `ari-cli` is meant to stay out of.
 *
 * @param {string} stateMachineArn
 * @param {string} runId
 * @param {string} [region]
 */
export async function describePipelineRun(
    stateMachineArn,
    runId,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    const executionArn = executionArnFor(stateMachineArn, runId);
    try {
        return await sfn.send(new DescribeExecutionCommand({ executionArn }));
    } catch (e) {
        if (e.name === 'ExecutionDoesNotExist') {
            throw new Error(
                `No execution found for run "${runId}" on this pipeline. Check the runId, or that "ari pipeline run" actually started it.`,
            );
        }
        throw e;
    }
}

/**
 * Resolves a pipeline name and applies the account guard.
 *
 *  1. SSM `stateMachineArn` (the registry), STS `GetCallerIdentity` (needs no
 *     IAM permission). The caller's account must equal the account embedded in
 *     the state machine ARN.
 *  2. With `{ manifest: true }` (the data-plane commands): also reads and
 *     validates the manifest. A pipeline without one fails with a "redeploy"
 *     message; an unknown schema fails with "update ari-cli". If the manifest
 *     has an `accountKey`, the caller's account must ALSO equal that key's
 *     account id in ~/.ari/config.json (fail closed when the mapping is
 *     missing), and the manifest's state machine ARN must be the registry's.
 *  3. Prints `[aws] account <id>[ (<accountKey>)], region <r>` to stderr once.
 *
 * @returns {Promise<{stateMachineArn: string, account: string, callerArn: string, region: string, manifest?: Object, accountKey?: string}>}
 */
export async function resolvePipeline(
    name,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
    { manifest: wantManifest = false } = {},
) {
    const d = withDeps(region, deps);
    const stateMachineArn = await resolveStateMachineArn(name, region, d);
    const { Account, Arn } = await d
        .createSts()
        .send(new GetCallerIdentityCommand({}));
    const pipelineAccount = stateMachineArn.split(':')[4];

    if (Account !== pipelineAccount) {
        throw new PipelineError(
            `You are signed in to AWS account ${Account}, but pipeline "${name}" lives in account ${pipelineAccount}. ` +
                'Switch accounts with: ari credentials -a <account> -r <role>',
        );
    }

    const result = {
        stateMachineArn,
        account: Account,
        callerArn: Arn,
        region,
    };

    if (wantManifest) {
        const manifest = validateDataManifest(
            await readManifestParameter(
                name,
                region,
                d,
                '"ari pipeline data …" / "ari pipeline fetch"',
            ),
            name,
        );
        if (
            manifest.stateMachineArn !== undefined &&
            manifest.stateMachineArn !== stateMachineArn
        ) {
            throw new PipelineError(
                `The manifest for "${name}" names a different state machine than the registry does; refusing to continue. Redeploy the pipeline.`,
            );
        }
        const { accountKey } = manifest;
        if (accountKey) {
            const expected = d.readLocalConfig()?.accounts?.[accountKey]
                ?.accountId;
            if (!expected) {
                throw new PipelineError(
                    `Pipeline "${name}" belongs to the "${accountKey}" account, but ~/.ari/config.json has no account id for it. Run: ari init`,
                );
            }
            if (Account !== expected) {
                throw new PipelineError(
                    `You are signed in to AWS account ${Account}, but pipeline "${name}" belongs to the "${accountKey}" account (${expected}). ` +
                        `Switch accounts with: ari credentials -a ${accountKey} -r <role>`,
                );
            }
        }
        result.manifest = manifest;
        result.accountKey = accountKey;
    }

    d.logErr(
        `[aws] account ${Account}${result.accountKey ? ` (${result.accountKey})` : ''}, region ${region}`,
    );
    return result;
}

/** `resolvePipeline` plus the validated manifest, for the data-plane commands. */
export const resolveDataPipeline = (name, region, deps) =>
    resolvePipeline(name, region, deps, { manifest: true });

/**
 * Lists executions (newest first). Only ListExecutions metadata is
 * returned — no input/output is ever fetched.
 *
 * @returns {Promise<{runs: Array<Object>, truncated: boolean}>}
 */
export async function listPipelineRuns(
    stateMachineArn,
    { status, limit = 20, all = false } = {},
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    const runs = [];
    let nextToken;
    do {
        const remaining = all ? 1000 : limit - runs.length;
        const page = await sfn.send(
            new ListExecutionsCommand({
                stateMachineArn,
                statusFilter: status,
                maxResults: Math.min(Math.max(remaining, 1), 1000),
                nextToken,
            }),
        );
        for (const ex of page.executions ?? []) {
            runs.push({
                runId: ex.name,
                executionArn: ex.executionArn,
                status: ex.status,
                startDate: ex.startDate,
                stopDate: ex.stopDate,
            });
        }
        nextToken = page.nextToken;
    } while (nextToken && (all || runs.length < limit));

    const truncated = !all && Boolean(nextToken);
    return { runs: all ? runs : runs.slice(0, limit), truncated };
}

/** StopExecution with the fixed `StoppedByOperator` error code. */
export async function stopPipelineRun(
    stateMachineArn,
    runId,
    cause,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    await sfn.send(
        new StopExecutionCommand({
            executionArn: executionArnFor(stateMachineArn, runId),
            error: 'StoppedByOperator',
            cause,
        }),
    );
}

/**
 * Fetches every page of an execution's history. `includeExecutionData:
 * false` asks Step Functions not to return task input/output at all, so
 * payloads never reach this process.
 */
export async function getExecutionHistory(
    stateMachineArn,
    runId,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    const executionArn = executionArnFor(stateMachineArn, runId);
    const events = [];
    let nextToken;
    try {
        do {
            const page = await sfn.send(
                new GetExecutionHistoryCommand({
                    executionArn,
                    includeExecutionData: false,
                    maxResults: 1000,
                    nextToken,
                }),
            );
            events.push(...(page.events ?? []));
            nextToken = page.nextToken;
        } while (nextToken);
    } catch (e) {
        if (e.name === 'ExecutionDoesNotExist') {
            throw new PipelineError(
                `No execution found for run "${runId}" on this pipeline.`,
            );
        }
        throw e;
    }
    return events;
}

/** Latest top-level state name from the newest StateEntered event, or null. */
async function currentStateName(sfn, executionArn) {
    try {
        const { events } = await sfn.send(
            new GetExecutionHistoryCommand({
                executionArn,
                reverseOrder: true,
                maxResults: 10,
                includeExecutionData: false,
            }),
        );
        const entered = (events ?? []).find((e) =>
            /StateEntered$/.test(e.type),
        );
        return entered?.stateEnteredEventDetails?.name ?? null;
    } catch {
        return null; // progress cosmetics only; the status poll surfaces real errors
    }
}

const MAX_TRANSIENT_FAILURES = 5;

/**
 * Shared polling loop for `wait` and `logs --follow`.
 *  - `tick()` does one poll and returns true when finished.
 *  - transient errors back off (x2, cap 60s, +/-20% jitter); the 5th
 *    consecutive one throws (exit 1).
 *  - an expired-credential error rebuilds the clients (`rebuild()`) and
 *    retries once immediately; a second in a row ends with 'expired'.
 *  - first SIGINT ends with 'interrupted' (never stops anything remote);
 *    a second SIGINT exits the process immediately with 130.
 *
 * @returns {Promise<'done'|'timeout'|'interrupted'|'expired'>}
 */
async function pollLoop({ tick, rebuild, intervalSec, timeoutSec, deps }) {
    let interrupted = false;
    let wake;
    const interruptSignal = new Promise((resolve) => {
        wake = resolve;
    });
    const off = deps.onSigint(() => {
        if (interrupted) deps.exit(EXIT.INTERRUPTED);
        interrupted = true;
        wake();
    });

    const startedAt = deps.now();
    let transient = 0;
    let expiredStreak = 0;
    try {
        for (;;) {
            if (interrupted) return 'interrupted';
            let delaySec = intervalSec;
            try {
                const done = await tick();
                transient = 0;
                expiredStreak = 0;
                if (done) return 'done';
            } catch (e) {
                if (isExpiredCreds(e)) {
                    if (expiredStreak >= 1) return 'expired';
                    expiredStreak += 1;
                    rebuild();
                    continue;
                }
                if (!isTransient(e)) throw e;
                expiredStreak = 0;
                transient += 1;
                if (transient >= MAX_TRANSIENT_FAILURES) {
                    throw new PipelineError(
                        `Giving up after ${MAX_TRANSIENT_FAILURES} consecutive transient AWS errors (last: ${e.name ?? e.code}). The execution is unaffected; retry the command.`,
                    );
                }
                const backoff = Math.min(intervalSec * 2 ** transient, 60);
                delaySec = backoff * (1 + (deps.random() * 0.4 - 0.2));
            }

            let sleepMs = delaySec * 1000;
            if (timeoutSec !== null && timeoutSec !== undefined) {
                const remainingMs =
                    timeoutSec * 1000 - (deps.now() - startedAt);
                if (remainingMs <= 0) return 'timeout';
                sleepMs = Math.min(sleepMs, remainingMs);
            }
            await Promise.race([deps.sleep(sleepMs), interruptSignal]);
        }
    } finally {
        off();
    }
}

/**
 * Polls DescribeExecution until the execution is terminal, the timeout
 * passes, the user presses Ctrl-C, or credentials expire for good. Never
 * calls StopExecution.
 *
 * @param {string} executionArn
 * @param {{intervalSec?: number, timeoutSec?: number|null, onProgress?: Function}} opts
 *   onProgress({status, state, elapsedSec}) fires when the status or
 *   current state name changes and at least every 60s.
 * @returns {Promise<{outcome: string, exitCode: number, status: string, execution: Object|null}>}
 */
export async function waitForExecution(
    executionArn,
    { intervalSec = 5, timeoutSec = null, onProgress = () => {} } = {},
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const d = withDeps(region, deps);
    let sfn = d.createSfn();
    const waitStart = d.now();
    let execution = null;
    let lastKey = null;
    let lastBeat = waitStart;

    const outcome = await pollLoop({
        intervalSec,
        timeoutSec,
        deps: d,
        rebuild: () => {
            sfn = d.createSfn();
        },
        tick: async () => {
            execution = await sfn.send(
                new DescribeExecutionCommand({ executionArn }),
            );
            const terminal = TERMINAL_STATUSES.includes(execution.status);
            const state = terminal
                ? null
                : await currentStateName(sfn, executionArn);
            const now = d.now();
            const key = `${execution.status}|${state}`;
            if (key !== lastKey || now - lastBeat >= 60_000) {
                lastKey = key;
                lastBeat = now;
                const origin = execution.startDate
                    ? new Date(execution.startDate).getTime()
                    : waitStart;
                onProgress({
                    status: execution.status,
                    state,
                    elapsedSec: (now - origin) / 1000,
                });
            }
            return terminal;
        },
    });

    const status = execution?.status ?? 'UNKNOWN';
    const exitCodes = {
        done: STATUS_EXIT[status] ?? EXIT.ERROR,
        timeout: EXIT.WAIT_TIMEOUT,
        interrupted: EXIT.INTERRUPTED,
        expired: EXIT.CREDENTIALS_EXPIRED,
    };
    return { outcome, exitCode: exitCodes[outcome], status, execution };
}

/** Name of the CloudWatch log group the state machine logs to. */
export async function getStateMachineLogGroup(
    stateMachineArn,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const sfn = withDeps(region, deps).createSfn();
    const { loggingConfiguration } = await sfn.send(
        new DescribeStateMachineCommand({ stateMachineArn }),
    );
    const arn =
        loggingConfiguration?.destinations?.[0]?.cloudWatchLogsLogGroup
            ?.logGroupArn;
    if (!arn || loggingConfiguration.level === 'OFF') {
        throw new PipelineError(
            "This pipeline's state machine has no CloudWatch logging configured, so there are no Step Functions logs to show.",
        );
    }
    // arn:aws:logs:REGION:ACCT:log-group:NAME:*
    return arn.split(':log-group:')[1].replace(/:\*$/, '');
}

/**
 * Quotes a value for a CloudWatch Logs JSON filter pattern. Rejects the
 * characters that could break out of the quoted string.
 */
function filterValue(value) {
    if (/["\\]/.test(value)) {
        throw new PipelineError(
            'Run ids containing quotes or backslashes are not supported by "logs".',
            EXIT.USAGE,
        );
    }
    return `"${value}"`;
}

async function fetchLogPage(logs, params) {
    try {
        return await logs.send(new FilterLogEventsCommand(params));
    } catch (e) {
        if (e.name === 'ResourceNotFoundException') {
            throw new PipelineError(
                `Log group "${params.logGroupName}" does not exist (yet).`,
            );
        }
        throw e;
    }
}

/**
 * One-shot fetch of the execution's Step Functions log events.
 * @returns {Promise<{events: Array<Object>, truncated: boolean}>}
 */
export async function fetchExecutionLogs(
    { logGroupName, executionArn, startTime, endTime, limit = 200 },
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const logs = withDeps(region, deps).createLogs();
    const events = [];
    let nextToken;
    do {
        const page = await fetchLogPage(logs, {
            logGroupName,
            filterPattern: `{ $.execution_arn = ${filterValue(executionArn)} }`,
            startTime,
            endTime,
            nextToken,
        });
        events.push(...(page.events ?? []));
        nextToken = page.nextToken;
    } while (nextToken && events.length < limit);
    events.sort((a, b) => a.timestamp - b.timestamp);
    return {
        events: events.slice(0, limit),
        truncated: events.length > limit || Boolean(nextToken),
    };
}

/**
 * One-shot fetch of the Lambda log groups for one run. There is no server-side
 * pattern: the run's own structured lines carry `runId`, platform lines
 * (START/END/REPORT) do not, so every event in the time window is classified
 * client-side by the allow-list in classifyLambdaLogEvent -- other runs' lines
 * are dropped, unrecognized lines are replaced by a fixed marker, and only the
 * rendered text is returned (never the raw message).
 *
 * @returns {Promise<{events: Array<{timestamp:number,eventId:string,source:string,line:string}>, truncated: boolean}>}
 */
export async function fetchLambdaLogs(
    { logGroupNames, runId, startTime, endTime, limit = 200, full = false },
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const logs = withDeps(region, deps).createLogs();
    const sources = lambdaLogSources(logGroupNames, runId, { full });
    const events = [];
    let more = false;
    for (const source of sources) {
        let nextToken;
        let count = 0;
        do {
            const page = await fetchLogPage(logs, {
                logGroupName: source.logGroupName,
                startTime,
                endTime,
                nextToken,
            });
            for (const ev of page.events ?? []) {
                const line = source.toLine(ev);
                if (line === null) continue;
                events.push({
                    timestamp: ev.timestamp,
                    eventId: ev.eventId,
                    source: source.id,
                    line,
                });
                count++;
            }
            nextToken = page.nextToken;
        } while (nextToken && count < limit);
        if (nextToken) more = true;
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    return {
        events: events.slice(0, limit),
        truncated: events.length > limit || more,
    };
}

/** Source descriptor for the Step Functions group (used when following several sources). */
export function sfnLogSource(logGroupName, executionArn, { full = false } = {}) {
    return {
        id: 'sfn',
        logGroupName,
        filterPattern: `{ $.execution_arn = ${filterValue(executionArn)} }`,
        toLine: (ev) => formatSfnLogEvent(ev, { full }),
    };
}

/**
 * Per-group descriptors for the Lambda groups: `toLine(ev)` renders an event
 * through the allow-list (or returns null to drop it).
 */
export function lambdaLogSources(logGroupNames, runId, { full = false } = {}) {
    const labels = lambdaLabels(logGroupNames);
    return logGroupNames.map((logGroupName) => ({
        id: `lambda:${labels[logGroupName]}`,
        logGroupName,
        toLine: (ev) => {
            const classified = classifyLambdaLogEvent(ev, { runId });
            return classified === null
                ? null
                : formatLambdaLogLine(ev, labels[logGroupName], classified.text, { full });
        },
    }));
}

/**
 * Follows the execution's log events until it is terminal and one further
 * poll returns nothing new. Calls `onEvents(newEvents)` (deduped by
 * eventId) as they arrive.
 * @returns {Promise<{outcome: string, exitCode: number, status: string}>}
 */
export async function followExecutionLogs(
    { logGroupName, executionArn, startTime, onEvents, intervalSec = 3, sources },
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const d = withDeps(region, deps);
    let sfn = d.createSfn();
    let logs = d.createLogs();
    const seen = new Set();
    // Default: the single Step Functions group, events passed through raw.
    // With `sources` ({ id, logGroupName, filterPattern?, toLine }), events are
    // rendered by each source's toLine (null = drop) and tagged with its id.
    const active = (
        sources ?? [
            {
                logGroupName,
                filterPattern: `{ $.execution_arn = ${filterValue(executionArn)} }`,
            },
        ]
    ).map((source) => ({ ...source, from: startTime }));
    let status = 'RUNNING';

    const outcome = await pollLoop({
        intervalSec,
        timeoutSec: null,
        deps: d,
        rebuild: () => {
            sfn = d.createSfn();
            logs = d.createLogs();
        },
        tick: async () => {
            const execution = await sfn.send(
                new DescribeExecutionCommand({ executionArn }),
            );
            status = execution.status;
            const fresh = [];
            for (const source of active) {
                let nextToken;
                do {
                    const page = await fetchLogPage(logs, {
                        logGroupName: source.logGroupName,
                        filterPattern: source.filterPattern,
                        startTime: source.from,
                        nextToken,
                    });
                    for (const ev of page.events ?? []) {
                        if (seen.has(ev.eventId)) continue;
                        seen.add(ev.eventId);
                        source.from = Math.max(source.from ?? 0, ev.timestamp);
                        if (!source.toLine) {
                            fresh.push(ev);
                            continue;
                        }
                        const line = source.toLine(ev);
                        if (line !== null) {
                            fresh.push({
                                timestamp: ev.timestamp,
                                eventId: ev.eventId,
                                source: source.id,
                                line,
                            });
                        }
                    }
                    nextToken = page.nextToken;
                } while (nextToken);
            }
            fresh.sort((a, b) => a.timestamp - b.timestamp);
            if (fresh.length > 0) onEvents(fresh);
            return TERMINAL_STATUSES.includes(status) && fresh.length === 0;
        },
    });

    const exitCodes = {
        done: STATUS_EXIT[status] ?? EXIT.ERROR,
        interrupted: EXIT.INTERRUPTED,
        expired: EXIT.CREDENTIALS_EXPIRED,
    };
    return { outcome, exitCode: exitCodes[outcome], status };
}

/* ------------------------------------------------------------------ */
/* Data plane (S3). Keys follow the manifest's `{stage}/{runId}/{id}`. */
/* ------------------------------------------------------------------ */

function s3Failure(e, what) {
    const status = e?.$metadata?.httpStatusCode;
    if (['NoSuchKey', 'NotFound'].includes(e?.name) || status === 404) {
        return new PipelineError(`${what}: no such object.`);
    }
    if (
        ['AccessDenied', 'Forbidden', 'AllAccessDisabled'].includes(e?.name) ||
        status === 403
    ) {
        return new PipelineError(
            `${what}: access denied by S3. Your role needs s3:ListBucket / s3:GetObject / s3:PutObject on the pipeline bucket ` +
                '(ViewOnlyAccess does not have them; use AdministratorAccess for now).',
        );
    }
    if (e?.name === 'NoSuchBucket') {
        return new PipelineError(
            `${what}: the bucket named in the manifest does not exist.`,
        );
    }
    return e;
}

/**
 * Lists a stage's objects for a run (keys, sizes, dates -- never content).
 * @returns {Promise<Array<{id: string, key: string, size: number, lastModified: Date|undefined}>>}
 */
export async function listDataObjects(
    manifest,
    stage,
    runId,
    { match } = {},
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const s3 = withDeps(region, deps).createS3();
    const prefix = prefixFor(manifest, stage, runId);
    const needle = match ? match.toLowerCase() : null;
    const objects = [];
    let token;
    try {
        do {
            const page = await s3.send(
                new ListObjectsV2Command({
                    Bucket: manifest.bucketName,
                    Prefix: prefix,
                    ContinuationToken: token,
                }),
            );
            for (const o of page.Contents ?? []) {
                const id = o.Key.slice(prefix.length);
                if (id && (!needle || id.toLowerCase().includes(needle))) {
                    objects.push({
                        id,
                        key: o.Key,
                        size: o.Size,
                        lastModified: o.LastModified,
                    });
                }
            }
            token = page.NextContinuationToken;
        } while (token);
    } catch (e) {
        throw s3Failure(e, `Listing ${prefix}`);
    }
    return objects;
}

/** Whether anything already exists under the stage/run prefix (for `load`). */
export async function dataPrefixHasObjects(
    manifest,
    stage,
    runId,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const s3 = withDeps(region, deps).createS3();
    const prefix = prefixFor(manifest, stage, runId);
    try {
        const page = await s3.send(
            new ListObjectsV2Command({
                Bucket: manifest.bucketName,
                Prefix: prefix,
                MaxKeys: 1,
            }),
        );
        return (page.Contents ?? []).length > 0;
    } catch (e) {
        throw s3Failure(e, `Listing ${prefix}`);
    }
}

/** Top-level regular files of a local directory (not recursive), sorted. */
export function listLocalFiles(localDir, deps = {}) {
    const fs = deps.fs ?? nodeFs;
    let entries;
    try {
        entries = fs.readdirSync(localDir, { withFileTypes: true });
    } catch (e) {
        throw new PipelineError(
            `Cannot read directory ${localDir} (${e.code ?? e.name}).`,
            EXIT.USAGE,
        );
    }
    const names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    if (names.length === 0) {
        throw new PipelineError(`No files found in ${localDir}`, EXIT.USAGE);
    }
    return names;
}

/**
 * Uploads `fileNames` (top-level files of `localDir`) to `<stage>/<runId>/`.
 * `onFile(name)` is called after each upload (the caller decides whether to
 * print names). Returns counts only.
 */
export async function uploadDataFiles(
    manifest,
    { stage, runId, localDir, fileNames, onFile = () => {} },
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const d = withDeps(region, deps);
    const s3 = d.createS3();
    let bytes = 0;
    for (const fileName of fileNames) {
        const body = d.fs.readFileSync(path.join(localDir, fileName));
        try {
            await s3.send(
                new PutObjectCommand({
                    Bucket: manifest.bucketName,
                    Key: keyFor(manifest, stage, runId, fileName),
                    Body: body,
                }),
            );
        } catch (e) {
            throw s3Failure(e, 'Upload');
        }
        bytes += body.length;
        onFile(fileName);
    }
    return { count: fileNames.length, bytes };
}

/**
 * HeadObject: size, version id, content type, last modified. No content.
 * (Needs s3:GetObject; recorded in CloudTrail like a read.)
 */
export async function headDataObject(
    manifest,
    stage,
    runId,
    id,
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const s3 = withDeps(region, deps).createS3();
    const key = keyFor(manifest, stage, runId, id);
    try {
        const r = await s3.send(
            new HeadObjectCommand({ Bucket: manifest.bucketName, Key: key }),
        );
        return {
            key,
            size: r.ContentLength ?? 0,
            versionId: r.VersionId,
            contentType: r.ContentType,
            lastModified: r.LastModified,
        };
    } catch (e) {
        throw s3Failure(e, `Object ${key}`);
    }
}

async function collectBody(body, limit) {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        total += buf.length;
        if (total > limit) {
            body.destroy?.();
            throw new PipelineError(
                `Object is larger than the ${limit}-byte read limit; refusing to buffer it.`,
                EXIT.USAGE,
            );
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

/**
 * GetObject into memory, bounded: `maxBytes` > 0 sends `Range: bytes=0-(n-1)`
 * so the rest of the object is not even transferred. `versionId` pins the
 * version the banner showed.
 * @returns {Promise<Buffer>}
 */
export async function readDataObject(
    manifest,
    stage,
    runId,
    id,
    { versionId, maxBytes } = {},
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const s3 = withDeps(region, deps).createS3();
    const key = keyFor(manifest, stage, runId, id);
    try {
        const r = await s3.send(
            new GetObjectCommand({
                Bucket: manifest.bucketName,
                Key: key,
                VersionId: versionId,
                Range: maxBytes ? `bytes=0-${maxBytes - 1}` : undefined,
            }),
        );
        return await collectBody(r.Body, maxBytes ?? Infinity);
    } catch (e) {
        throw s3Failure(e, `Object ${key}`);
    }
}

/**
 * Streams an object to `outPath` (0600, no overwrite without `force`, binary
 * refused before the file exists). Returns the byte count.
 */
export async function downloadDataObject(
    manifest,
    stage,
    runId,
    id,
    outPath,
    { versionId, force = false } = {},
    region = DEFAULT_PIPELINE_REGION,
    deps = {},
) {
    const d = withDeps(region, deps);
    const key = keyFor(manifest, stage, runId, id);
    let r;
    try {
        r = await d.createS3().send(
            new GetObjectCommand({
                Bucket: manifest.bucketName,
                Key: key,
                VersionId: versionId,
            }),
        );
    } catch (e) {
        throw s3Failure(e, `Object ${key}`);
    }
    return writeProtectedFile(outPath, r.Body, { force, fs: d.fs });
}
