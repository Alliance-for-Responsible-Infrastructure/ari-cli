import * as fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { styles } from '#src/lib/cli/terminal.js';
import {
    generateRunId,
    startPipelineRun,
    describePipelineRun,
    resolvePipeline,
    listPipelineRuns,
    stopPipelineRun,
    getExecutionHistory,
    waitForExecution,
    getStateMachineLogGroup,
    fetchExecutionLogs,
    followExecutionLogs,
    getPipelineManifest,
    fetchLambdaLogs,
    lambdaLogSources,
    sfnLogSource,
} from '#src/lib/cli/pipeline.js';
import {
    EXIT,
    PipelineError,
    TERMINAL_STATUSES,
    parseDuration,
    formatDuration,
    formatElapsed,
    formatClock,
    formatSfnLogEvent,
    foldHistory,
} from '#src/lib/cli/pipeline-utils.js';
import { confirm, isInteractive } from '#src/lib/cli/prompt.js';
import {
    DEFAULT_BOOTSTRAP_QUALIFIER,
    getBootstrapVersion,
    getCallerAccount,
} from '#src/lib/cli/aws.js';
import BaseAriCommand from './base-command.js';

const { success, error, warn, emphasis, bold } = styles;

const statusStyle = (status) => {
    if (status === 'SUCCEEDED') return success;
    if (status === 'RUNNING') return emphasis;
    return error;
};

const pad = (value, width) => String(value ?? '').padEnd(width);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const durationSec = (start, stop, now = Date.now()) =>
    start ? (new Date(stop ?? now) - new Date(start)) / 1000 : null;

/** Prints the protected-data banner (stderr) before any payload-bearing output. */
function printContentBanner(what, name, callerArn) {
    console.error(
        warn('PROTECTED DATA'),
        `- ${what} may contain content from a protected data set (pipeline ${name}).`,
        `This read is recorded in CloudTrail under ${callerArn}.`,
    );
}

/** Next-step hints printed after a non-successful run. */
function printFailureHints(log, name, runId) {
    log(
        `  ari pipeline history ${name} ${runId}   (which step failed)\n` +
            `  ari pipeline logs ${name} ${runId}      (Step Functions logs)`,
    );
}

/**
 * Validates --interval / --timeout *before* anything starts (so a typo can't
 * leave a run started but unwatched).
 */
function parseWaitOptions({ interval, timeout }) {
    const intervalSec = interval === undefined ? 5 : Number(interval);
    if (!Number.isFinite(intervalSec) || intervalSec < 2) {
        throw new PipelineError(
            '--interval must be a number of seconds, 2 or more.',
            EXIT.USAGE,
        );
    }
    return { intervalSec, timeoutSec: parseDuration(timeout) };
}

/**
 * Shared wait step for `run --wait` and `wait`: drives waitForExecution,
 * prints progress and the final summary, and records the exit code on `cmd`.
 */
async function waitAndReport(cmd, { executionArn }) {
    const { name, runId, region, options } = cmd;
    const json = Boolean(options.json);
    const { intervalSec, timeoutSec } = parseWaitOptions(options);
    const out = json ? (...a) => console.error(...a) : console.log;
    let inPlace = false;
    let lastState = null;

    const onProgress = ({ status, state, elapsedSec }) => {
        if (json) return;
        const line = ` ${formatElapsed(elapsedSec)}  ${statusStyle(status)(status)}${state ? `  ${state}` : ''}`;
        if (
            process.stdout.isTTY &&
            status === 'RUNNING' &&
            state === lastState
        ) {
            process.stdout.write(`\r\x1b[K${line}`);
            inPlace = true;
        } else {
            if (inPlace) process.stdout.write('\n');
            inPlace = false;
            console.log(line);
        }
        lastState = state;
    };

    const result = await waitForExecution(
        executionArn,
        { intervalSec, timeoutSec, onProgress },
        region,
    );
    if (inPlace) process.stdout.write('\n');

    const { execution, status } = result;
    cmd.exitCode = result.exitCode;
    const startDate = execution?.startDate;
    const stopDate = execution?.stopDate;
    const secs = durationSec(startDate, stopDate);

    if (result.outcome === 'done') {
        out(
            bold(`Run ${runId}:`),
            statusStyle(status)(status),
            `(${formatDuration(secs)})`,
        );
        if (status !== 'SUCCEEDED') printFailureHints(out, name, runId);
    } else if (result.outcome === 'timeout') {
        console.error(
            warn('Timed out:'),
            `stopped waiting after ${formatDuration(timeoutSec)}. Run ${runId} is still ${status}.`,
            `\n  Resume: ari pipeline wait ${name} ${runId}   Stop it: ari pipeline stop ${name} ${runId}`,
        );
    } else if (result.outcome === 'interrupted') {
        console.error(
            `\nStopped waiting. Run ${runId} is still ${status}.\n` +
                `  Resume: ari pipeline wait ${name} ${runId}   Stop it: ari pipeline stop ${name} ${runId}`,
        );
    } else if (result.outcome === 'expired') {
        console.error(
            error('Credentials expired;'),
            `the execution is unaffected (still ${status}).\n` +
                `  Re-run ari credentials, then: ari pipeline wait ${name} ${runId}`,
        );
    }

    if (json) {
        console.log(
            JSON.stringify({
                runId,
                status,
                startDate: iso(startDate),
                stopDate: iso(stopDate),
                durationSec: stopDate ? secs : null,
            }),
        );
    }
}

/**
 * `ari pipeline run <name>` — starts an execution of a named pipeline.
 * Resolves <name> to a state machine ARN via the registry SSM parameter
 * (see src/lib/cli/pipeline.js) and starts it with either a caller-supplied
 * runId (--run-id, so data pre-loaded under a known id is visible to this
 * run) or a freshly generated one — no knowledge of what the pipeline
 * actually does. With --wait, then polls to a terminal state (exit codes in
 * waitForExecution / the spec).
 */
export class PipelineRunCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.region = options.region;
        this.runId = options.runId;
        this.exitCode = 0;
        this.addActions();
    }

    async executeRun() {
        // Validate wait options first: never start a run we then can't watch.
        if (this.options.wait) parseWaitOptions(this.options);

        const { stateMachineArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const runId = this.runId ?? generateRunId();
        this.runId = runId;
        const { executionArn } = await startPipelineRun(
            stateMachineArn,
            runId,
            this.region,
        );

        const out = this.options.json ? console.error : console.log;
        out(
            success('Started:'),
            `pipeline ${emphasis(this.name)}, run ${emphasis(runId)}`,
        );
        out(`Execution: ${executionArn}`);

        if (this.options.wait) {
            await waitAndReport(this, { executionArn });
        } else if (this.options.json) {
            console.log(JSON.stringify({ runId, executionArn }));
        } else {
            console.log(
                'Check status with:',
                emphasis(`ari pipeline status ${this.name} ${runId}`),
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeRun);
    }
}

/**
 * `ari pipeline wait <name> <runId>` — the same wait loop as `run --wait`,
 * for an execution that is already running.
 */
export class PipelineWaitCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.exitCode = 0;
        this.addActions();
    }

    async executeWait() {
        parseWaitOptions(this.options);
        const { stateMachineArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        // Fail fast with the friendly "no such run" error.
        const execution = await describePipelineRun(
            stateMachineArn,
            this.runId,
            this.region,
        );
        await waitAndReport(this, { executionArn: execution.executionArn });
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeWait);
    }
}

/**
 * `ari pipeline status <name> <runId>` — reports a pipeline run's status by
 * describing its Step Functions execution directly. No pipeline-specific
 * per-file detail (that would require knowing that pipeline's own
 * DynamoDB schema) — just the execution-level status every pipeline's
 * state machine has in common. The execution *output* is hidden unless
 * --show-output (ari-cli cannot know a pipeline's output is content-free).
 */
export class PipelineStatusCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.addActions();
    }

    async executeStatus() {
        const { stateMachineArn, callerArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const execution = await describePipelineRun(
            stateMachineArn,
            this.runId,
            this.region,
        );

        console.log(
            bold(`Run ${this.runId}`),
            `(${this.name}):`,
            statusStyle(execution.status)(execution.status),
        );
        console.log(
            `Started: ${new Date(execution.startDate).toLocaleString()}`,
        );
        if (execution.stopDate) {
            console.log(
                `Stopped: ${new Date(execution.stopDate).toLocaleString()}`,
            );
        }
        if (execution.status !== 'RUNNING' && execution.output) {
            if (this.options.showOutput) {
                printContentBanner('Execution output', this.name, callerArn);
                console.log('Output:', execution.output);
            } else {
                console.log(
                    'Output: hidden (may contain protected content). Use --show-output to print it.',
                );
            }
        }
        if (execution.status === 'FAILED' || execution.status === 'TIMED_OUT') {
            console.log(
                warn('Note:'),
                'this only reflects the execution as a whole. For which step failed:',
                emphasis(`ari pipeline history ${this.name} ${this.runId}`),
                '; for logs:',
                emphasis(`ari pipeline logs ${this.name} ${this.runId}`),
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeStatus);
    }
}

/**
 * `ari pipeline runs <name>` — lists executions (ListExecutions metadata
 * only; no input/output is fetched). Execution name == runId.
 */
export class PipelineRunsCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.region = options.region;
        this.addActions();
    }

    async executeRuns() {
        const { status, all, json } = this.options;
        const limit =
            this.options.limit === undefined ? 20 : Number(this.options.limit);
        if (!Number.isInteger(limit) || limit < 1) {
            throw new PipelineError(
                '--limit must be a positive integer.',
                EXIT.USAGE,
            );
        }
        if (status && ![...TERMINAL_STATUSES, 'RUNNING'].includes(status)) {
            throw new PipelineError(
                `--status must be one of RUNNING, ${TERMINAL_STATUSES.join(', ')}.`,
                EXIT.USAGE,
            );
        }

        const { stateMachineArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const { runs, truncated } = await listPipelineRuns(
            stateMachineArn,
            { status, limit, all },
            this.region,
        );

        const rows = runs.map((r) => ({
            runId: r.runId,
            status: r.status,
            startDate: iso(r.startDate),
            stopDate: iso(r.stopDate),
            durationSec: durationSec(r.startDate, r.stopDate),
        }));

        if (json) {
            console.log(JSON.stringify(rows));
            return;
        }

        const idWidth = Math.max(6, ...rows.map((r) => r.runId.length)) + 2;
        console.log(
            bold(
                `${pad('RUN ID', idWidth)}${pad('STATUS', 11)}${pad('STARTED', 18)}DURATION`,
            ),
        );
        for (const r of runs) {
            const started = `${formatClock(r.startDate).slice(0, 5)}`;
            const day = new Date(r.startDate);
            const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
            const dur = durationSec(r.startDate, r.stopDate);
            console.log(
                pad(r.runId, idWidth) +
                    statusStyle(r.status)(pad(r.status, 11)) +
                    pad(`${date} ${started}`, 18) +
                    formatDuration(dur),
            );
        }
        console.log(
            `${rows.length} run${rows.length === 1 ? '' : 's'}` +
                (truncated
                    ? ` (showing ${limit} max; use --all or --limit for more)`
                    : '') +
                '; executions older than 90 days are not retained by Step Functions',
        );
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeRuns);
    }
}

/**
 * `ari pipeline stop <name> <runId>` — StopExecution behind a confirmation.
 * Refuses non-RUNNING runs (exit 1); a TTY gets a y/N prompt, non-TTY needs
 * --yes (else exit 2).
 */
export class PipelineStopCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.exitCode = 0;
        this.addActions();
    }

    async executeStop() {
        const { stateMachineArn, callerArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const execution = await describePipelineRun(
            stateMachineArn,
            this.runId,
            this.region,
        );
        if (execution.status !== 'RUNNING') {
            throw new PipelineError(
                `Run "${this.runId}" is ${execution.status}, not RUNNING; nothing to stop.`,
            );
        }

        if (!this.options.yes) {
            if (!isInteractive()) {
                throw new PipelineError(
                    'Refusing to stop a run without confirmation on a non-interactive terminal. Re-run with --yes.',
                    EXIT.USAGE,
                );
            }
            const ok = await confirm(
                `Stop run ${this.runId} of ${this.name}? In-flight work is not cancelled.`,
            );
            if (!ok) {
                throw new PipelineError('Not stopped.', EXIT.USAGE);
            }
        }

        await stopPipelineRun(
            stateMachineArn,
            this.runId,
            this.options.cause ?? `Stopped via ari-cli by ${callerArn}`,
            this.region,
        );
        console.log(success('Stop requested:'), `run ${emphasis(this.runId)}`);
        console.log(
            warn('Note:'),
            "in-flight Lambda invocations are NOT cancelled (e.g. a Bedrock call already underway will finish and may still write output), so this run's data is left partial.",
        );
        console.log(
            `The run id "${this.runId}" cannot be reused (execution names are unique for 90 days); use a new --run-id.`,
        );
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeStop);
    }
}

/**
 * `ari pipeline history <name> <runId>` — one row per state, built by the
 * allow-listing foldHistory(); payloads (input/output/Map items) are never
 * printed, `cause` only with --show-cause.
 */
export class PipelineHistoryCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.addActions();
    }

    #resultText(s) {
        if (s.nested) {
            const parts = [`${s.calls} calls`];
            if (s.retried) parts.push(`${s.retried} retried`);
            if (s.result === 'FAILED') parts.push(`FAILED error=${s.error}`);
            return parts.join(', ');
        }
        if (s.type === 'Map' && s.iterationsStarted !== undefined) {
            const ok = s.iterationsOk ?? 0;
            const failed = s.iterationsFailed ?? 0;
            return `${ok} ok, ${failed} failed (items ${s.items ?? '?'})`;
        }
        if (s.result === 'FAILED') return `FAILED error=${s.error}`;
        if (s.result === 'RUNNING') return 'running';
        return 'ok';
    }

    async executeHistory() {
        const { stateMachineArn, callerArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const { showCause, failedOnly, json } = this.options;
        const events = await getExecutionHistory(
            stateMachineArn,
            this.runId,
            this.region,
        );
        const folded = foldHistory(events, {
            includeCause: Boolean(showCause),
        });
        let states = folded.states;
        if (failedOnly) {
            states = states.filter(
                (s) =>
                    s.result === 'FAILED' ||
                    (s.nested
                        ? s.failures > 0
                        : s.failures > 0 || s.iterationsFailed > 0),
            );
        }

        if (json) {
            console.log(
                JSON.stringify({
                    runId: this.runId,
                    execution: folded.execution,
                    states: states.map((s) => ({
                        ...s,
                        enteredAt: iso(s.enteredAt),
                        exitedAt: iso(s.exitedAt),
                    })),
                }),
            );
            return;
        }

        if (showCause) {
            printContentBanner('Failure causes', this.name, callerArn);
        }
        const w =
            Math.max(
                12,
                ...states.map((s) => s.name.length + (s.nested ? 2 : 0)),
            ) + 2;
        console.log(
            bold(
                `${pad('STATE', w)}${pad('TYPE', 10)}${pad('ENTERED', 10)}${pad('DURATION', 10)}${pad('ATTEMPTS', 10)}RESULT`,
            ),
        );
        for (const s of states) {
            if (s.nested) {
                const avg =
                    s.avgDurationSec === null
                        ? '-'
                        : `avg ${formatDuration(s.avgDurationSec)}`;
                console.log(
                    `${pad(`  ${s.name}`, w)}${pad(s.type, 10)}${pad('-', 10)}${pad(avg, 10)}${pad('-', 10)}${this.#resultText(s)}`,
                );
            } else {
                const failed = s.result === 'FAILED';
                const line =
                    `${pad(s.name, w)}${pad(s.type, 10)}${pad(formatClock(s.enteredAt), 10)}` +
                    `${pad(formatDuration(s.durationSec), 10)}${pad(s.type === 'Map' ? '-' : s.attempts || '-', 10)}${this.#resultText(s)}`;
                console.log(failed ? error(line) : line);
            }
            if (showCause && s.cause) console.log(`    cause: ${s.cause}`);
        }
        const ex = folded.execution;
        console.log(
            `Execution: ${statusStyle(ex.status)(ex.status)}${ex.error ? ` error=${ex.error}` : ''}`,
        );
        if (showCause && ex.cause) console.log(`    cause: ${ex.cause}`);
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeHistory);
    }
}

/**
 * `ari pipeline logs <name> <runId> [--source sfn|lambda|all]` — CloudWatch
 * log events for one execution. Every line is rendered through an
 * allow-list (formatSfnLogEvent for Step Functions, classifyLambdaLogEvent
 * for Lambda), so no payload or free text reaches the terminal. `lambda` and
 * `all` need the pipeline manifest (`logGroups.lambda`).
 */
export class PipelineLogsCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.exitCode = 0;
        this.addActions();
    }

    async executeLogs() {
        const { source = 'sfn', follow, json, full } = this.options;
        const wantSfn = source === 'sfn' || source === 'all';
        const wantLambda = source === 'lambda' || source === 'all';
        const limit =
            this.options.limit === undefined ? 200 : Number(this.options.limit);
        if (!Number.isInteger(limit) || limit < 1) {
            throw new PipelineError(
                '--limit must be a positive integer.',
                EXIT.USAGE,
            );
        }
        const sinceSec = parseDuration(this.options.since);

        const { stateMachineArn } = await resolvePipeline(
            this.name,
            this.region,
        );
        const execution = await describePipelineRun(
            stateMachineArn,
            this.runId,
            this.region,
        );
        const sfnLogGroup = wantSfn
            ? await getStateMachineLogGroup(stateMachineArn, this.region)
            : null;
        const manifest = wantLambda
            ? await getPipelineManifest(this.name, this.region)
            : null;
        const lambdaGroups = manifest ? manifest.logGroups.lambda : [];

        const startTime =
            sinceSec === null
                ? new Date(execution.startDate).getTime()
                : Date.now() - sinceSec * 1000;
        // Lambda REPORT lines are written just after the invocation returns.
        const endTime = execution.stopDate
            ? new Date(execution.stopDate).getTime() + 10_000
            : undefined;

        if (wantLambda) {
            console.error(
                warn('Note:'),
                'Lambda START/END/REPORT lines carry a request id, not a run id, so they are selected by time window;',
                'concurrent runs of this pipeline may interleave. Only fixed-format lines are shown.',
            );
        }

        const print = (events) => {
            for (const ev of events) {
                const line =
                    ev.line ?? formatSfnLogEvent(ev, { full });
                if (json) {
                    console.log(
                        JSON.stringify({
                            timestamp: new Date(ev.timestamp).toISOString(),
                            line,
                        }),
                    );
                } else {
                    console.log(line);
                }
            }
        };

        if (follow) {
            const followArgs = {
                logGroupName: sfnLogGroup,
                executionArn: execution.executionArn,
                startTime,
                onEvents: print,
            };
            if (wantLambda) {
                followArgs.sources = [
                    ...(wantSfn
                        ? [
                              sfnLogSource(sfnLogGroup, execution.executionArn, {
                                  full,
                              }),
                          ]
                        : []),
                    ...lambdaLogSources(lambdaGroups, this.runId, { full }),
                ];
            }
            const result = await followExecutionLogs(followArgs, this.region);
            this.exitCode = result.exitCode === EXIT.OK ? 0 : result.exitCode;
            if (result.outcome === 'interrupted') {
                console.error(
                    `\nStopped following. Run ${this.runId} is unaffected.`,
                );
            } else if (result.outcome === 'expired') {
                console.error(
                    error('Credentials expired;'),
                    'the execution is unaffected. Re-run ari credentials, then:',
                    `ari pipeline logs ${this.name} ${this.runId} --source ${source} --follow`,
                );
            }
            return;
        }

        const all = [];
        let truncated = false;
        if (wantSfn) {
            const result = await fetchExecutionLogs(
                {
                    logGroupName: sfnLogGroup,
                    executionArn: execution.executionArn,
                    startTime,
                    limit,
                },
                this.region,
            );
            all.push(
                ...result.events.map((ev) => ({
                    timestamp: ev.timestamp,
                    line: formatSfnLogEvent(ev, { full }),
                })),
            );
            truncated ||= result.truncated;
        }
        if (wantLambda) {
            const result = await fetchLambdaLogs(
                {
                    logGroupNames: lambdaGroups,
                    runId: this.runId,
                    startTime,
                    endTime,
                    limit,
                    full,
                },
                this.region,
            );
            all.push(...result.events);
            truncated ||= result.truncated;
        }
        all.sort((a, b) => a.timestamp - b.timestamp);
        print(all.slice(0, limit));
        if (all.length === 0 && !json) {
            console.error(
                'No log events found for this run in the selected window.',
            );
        }
        if ((truncated || all.length > limit) && !json) {
            console.error(
                warn('Note:'),
                `showing the first ${limit} events; use --limit for more.`,
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeLogs);
    }
}

const QUALIFIER_RE = /^[A-Za-z0-9]{1,10}$/;
const APPROVAL_MODES = ['never', 'any-change', 'broadening'];

/**
 * Shared base for `ari pipeline deploy|diff|synth <name>`: thin, cwd-based
 * wrappers around `npx cdk <verb>` (not a name -> repo-path registry). Must
 * be run from inside the named pipeline's own repo directory. Reads that
 * repo's own `./config/default.json` directly off disk (plain fs, *not* the
 * `config` npm package, which resolves relative to ari-cli's install) for
 * `projectName = "{environment}-{workloadName}"`, `iac.account` and
 * `iac.region`, then applies, before spawning cdk:
 *
 *  1. the wrong-directory check (<name> must equal projectName);
 *  2. the account guard: STS GetCallerIdentity must equal the account id that
 *     ~/.ari/config.json holds for `iac.account` (fail closed if unmapped);
 *  3. the region check: AWS_REGION / AWS_DEFAULT_REGION, if set, must equal
 *     `iac.region`;
 *  4. (deploy/diff) the CDK bootstrap check via SSM.
 *
 * There is intentionally no --region/--profile flag: region comes from the
 * repo's config and identity from `ari credentials`/AWS_PROFILE, so the guard
 * has a single source of truth. cdk gets a fixed allow-listed argv, never
 * arbitrary passthrough, with stdio inherited so its own output reaches the
 * user.
 */
class PipelineCdkCommand extends BaseAriCommand {
    /** cdk subcommand (`deploy` | `diff` | `synth`). */
    verb = '';
    /** Whether the bootstrap check applies. */
    checksBootstrap = true;

    constructor(options) {
        super(options);
        this.name = options.name;
        this.addActions();
    }

    #readConfig() {
        const configPath = path.join(this.cwd, 'config', 'default.json');
        let config;
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            throw new PipelineError(
                `Could not read ${configPath} (${e.message}) — run "ari pipeline ${this.verb} ${this.name}" from inside ${this.name}'s own repo directory.`,
                EXIT.USAGE,
            );
        }
        const { environment, workloadName, account, region } = config.iac ?? {};
        return {
            projectName: `${environment}-${workloadName}`,
            accountKey: account,
            region,
        };
    }

    #readQualifier() {
        let context;
        try {
            context = JSON.parse(
                fs.readFileSync(path.join(this.cwd, 'cdk.json'), 'utf-8'),
            ).context;
        } catch {
            return DEFAULT_BOOTSTRAP_QUALIFIER;
        }
        const q = context?.['@aws-cdk/core:bootstrapQualifier'];
        if (q === undefined) return DEFAULT_BOOTSTRAP_QUALIFIER;
        if (typeof q !== 'string' || !QUALIFIER_RE.test(q)) {
            throw new PipelineError(
                'cdk.json context "@aws-cdk/core:bootstrapQualifier" must be 1-10 letters/digits.',
                EXIT.USAGE,
            );
        }
        return q;
    }

    /** Extra allow-listed cdk args for this verb. */
    cdkArgs() {
        return [];
    }

    #spawnCdk(args) {
        // Mirrors scripts/lib/identity.js: never hand a Bedrock bearer token
        // to a subprocess. (Harmless for cdk; keeps the invariant uniform.)
        const env = { ...process.env };
        delete env.AWS_BEARER_TOKEN_BEDROCK;
        const result = spawnSync('npx', ['cdk', ...args], {
            cwd: this.cwd,
            stdio: 'inherit',
            env,
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new PipelineError(
                `"npx cdk ${args[0]}" exited with code ${result.status}`,
            );
        }
    }

    /** Hook for deploy: confirm before spawning. Default none. */
    async beforeSpawn() {}

    async executeCdk() {
        const { projectName, accountKey, region } = this.#readConfig();
        if (projectName !== this.name) {
            throw new PipelineError(
                `"${this.name}" doesn't match this directory's pipeline ("${projectName}", per ./config/default.json) — run this from inside ${this.name}'s own repo directory instead.`,
                EXIT.USAGE,
            );
        }
        if (!accountKey || !region) {
            throw new PipelineError(
                'config/default.json must set iac.account and iac.region; refusing to continue without an account to guard.',
                EXIT.USAGE,
            );
        }

        const expected = this.localConfig?.accounts?.[accountKey]?.accountId;
        if (!expected) {
            throw new PipelineError(
                `This pipeline belongs to the "${accountKey}" account, but ~/.ari/config.json has no account id for it. Run: ari init`,
                EXIT.USAGE,
            );
        }

        for (const v of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
            if (process.env[v] && process.env[v] !== region) {
                throw new PipelineError(
                    `${v} is "${process.env[v]}" but this pipeline deploys to ${region} (iac.region). Unset ${v} or fix config/default.json.`,
                    EXIT.USAGE,
                );
            }
        }

        const account = await getCallerAccount(region);
        if (account !== expected) {
            throw new PipelineError(
                `You are signed in to AWS account ${account}, but pipeline "${this.name}" belongs to the "${accountKey}" account (${expected}). ` +
                    `Switch accounts with: ari credentials -a ${accountKey} -r <role>`,
                EXIT.USAGE,
            );
        }
        console.error(
            `[aws] account ${account} (${accountKey}), region ${region}`,
        );

        const bootstrapCmd = `npx cdk bootstrap aws://${account}/${region}`;
        let bootstrapFirst = false;
        if (this.checksBootstrap) {
            if (this.options.bootstrap) {
                bootstrapFirst = true;
            } else if (
                !(await getBootstrapVersion(this.#readQualifier(), region))
            ) {
                throw new PipelineError(
                    `This account/region is not CDK-bootstrapped. Run: ari pipeline deploy ${this.name} --bootstrap  (or: ${bootstrapCmd})`,
                    EXIT.USAGE,
                );
            }
        }

        await this.beforeSpawn();

        if (bootstrapFirst) {
            if (!this.options.yes) {
                if (!isInteractive()) {
                    throw new PipelineError(
                        'Refusing to bootstrap without confirmation on a non-interactive terminal. Re-run with --yes.',
                        EXIT.USAGE,
                    );
                }
                const ok = await confirm(
                    `Run "${bootstrapCmd}" for ${this.name}?`,
                );
                if (!ok) {
                    throw new PipelineError('Not bootstrapped.', EXIT.USAGE);
                }
            }
            console.log(success('Bootstrapping:'), emphasis(bootstrapCmd));
            this.#spawnCdk(['bootstrap', `aws://${account}/${region}`]);
        }

        console.log(
            success(`${this.verb}:`),
            `${emphasis(projectName)} via "npx cdk ${this.verb}" (output below is CDK's own)`,
        );
        this.#spawnCdk([this.verb, ...this.cdkArgs()]);
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeCdk);
    }
}

/**
 * `ari pipeline deploy <name>` — guarded `npx cdk deploy`. `--require-approval
 * never|any-change|broadening` passes through (default: CDK's own); `never`
 * off a TTY needs `--yes`. `--bootstrap` runs `cdk bootstrap` first.
 */
export class PipelineDeployCommand extends PipelineCdkCommand {
    verb = 'deploy';

    cdkArgs() {
        const mode = this.options.requireApproval;
        return mode ? ['--require-approval', mode] : [];
    }

    async beforeSpawn() {
        const mode = this.options.requireApproval;
        if (mode !== undefined && !APPROVAL_MODES.includes(mode)) {
            throw new PipelineError(
                `--require-approval must be one of: ${APPROVAL_MODES.join(', ')}.`,
                EXIT.USAGE,
            );
        }
        if (mode === 'never') {
            console.error(
                warn('Warning:'),
                'deploying with --require-approval never: security-sensitive changes (IAM, bucket policy) will NOT be confirmed.',
            );
            if (!this.options.yes && !isInteractive()) {
                throw new PipelineError(
                    'Refusing --require-approval never on a non-interactive terminal without --yes.',
                    EXIT.USAGE,
                );
            }
        }
    }
}

/** `ari pipeline diff <name>` — guarded `npx cdk diff`. */
export class PipelineDiffCommand extends PipelineCdkCommand {
    verb = 'diff';
}

/** `ari pipeline synth <name> [--quiet]` — guarded `npx cdk synth`. */
export class PipelineSynthCommand extends PipelineCdkCommand {
    verb = 'synth';
    checksBootstrap = false;

    cdkArgs() {
        return this.options.quiet ? ['--quiet'] : [];
    }
}
