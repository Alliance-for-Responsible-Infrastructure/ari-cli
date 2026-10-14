/**
 * Tests for src/lib/cli/pipeline.js. No AWS: every function takes an
 * injected `deps` (fake client factories, fake clock/sleep, fake SIGINT).
 */
import { jest, describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import {
    resolvePipeline,
    resolveStateMachineArn,
    startPipelineRun,
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
    resolveDataPipeline,
    listDataObjects,
    dataPrefixHasObjects,
    listLocalFiles,
    uploadDataFiles,
    headDataObject,
    readDataObject,
    downloadDataObject,
} from '#src/lib/cli/pipeline.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { MANIFEST as DATA_MANIFEST } from '../helpers/manifest-fixture.js';

const SM_ARN =
    'arn:aws:states:us-east-1:123456789012:stateMachine:dev-demo-pipeline';
const EXEC_ARN =
    'arn:aws:states:us-east-1:123456789012:execution:dev-demo-pipeline:run-1';

const err = (name, extra = {}) =>
    Object.assign(new Error(name), { name, ...extra });

/** Fake AWS client: handlers keyed by command class name, each a queue or fn. */
function fakeClient(handlers = {}) {
    const calls = [];
    const queues = {};
    return {
        calls,
        send: jest.fn(async (command) => {
            const type = command.constructor.name;
            calls.push({ type, input: command.input });
            const h = handlers[type];
            if (Array.isArray(h)) {
                queues[type] ??= [...h];
                const next =
                    queues[type].length > 1
                        ? queues[type].shift()
                        : queues[type][0];
                if (next instanceof Error) throw next;
                return typeof next === 'function' ? next(command.input) : next;
            }
            if (typeof h === 'function') return h(command.input);
            throw new Error(`unexpected command ${type}`);
        }),
    };
}

/** Deps with a controllable clock: sleep() advances `now`. */
function makeDeps(overrides = {}) {
    let t = 1_000_000;
    const sleeps = [];
    let sigintHandler = null;
    const deps = {
        sleeps,
        now: () => t,
        sleep: jest.fn(async (ms) => {
            sleeps.push(ms);
            t += ms;
        }),
        random: () => 0.5, // zero jitter
        onSigint: (h) => {
            sigintHandler = h;
            return () => {
                sigintHandler = null;
            };
        },
        sigint: () => sigintHandler?.(),
        hasSigintHandler: () => sigintHandler !== null,
        exit: jest.fn(),
        logErr: jest.fn(),
        ...overrides,
    };
    return deps;
}

const running = {
    status: 'RUNNING',
    startDate: new Date(1_000_000 - 12_000),
    executionArn: EXEC_ARN,
};
const history = (name) => ({
    events: name
        ? [{ type: 'TaskStateEntered', stateEnteredEventDetails: { name } }]
        : [],
});

describe('resolveStateMachineArn / resolvePipeline', () => {
    const ssmOk = () =>
        fakeClient({ GetParameterCommand: [{ Parameter: { Value: SM_ARN } }] });
    const stsFor = (Account) =>
        fakeClient({
            GetCallerIdentityCommand: [
                {
                    Account,
                    Arn: 'arn:aws:sts::123456789012:assumed-role/Admin/jo',
                },
            ],
        });

    test('reads the registry parameter and maps ParameterNotFound to a friendly error', async () => {
        const ssm = fakeClient({
            GetParameterCommand: [err('ParameterNotFound')],
        });
        await expect(
            resolveStateMachineArn('nope', 'us-east-1', {
                createSsm: () => ssm,
            }),
        ).rejects.toThrow(/No pipeline named "nope"/);
        expect(ssm.calls[0].input.Name).toBe(
            '/ari/pipelines/nope/stateMachineArn',
        );
    });

    test('returns the ARN + identity and prints the account line to stderr', async () => {
        const deps = makeDeps({
            createSsm: ssmOk,
            createSts: () => stsFor('123456789012'),
        });
        const result = await resolvePipeline('dev-demo', 'us-east-1', deps);
        expect(result).toMatchObject({
            stateMachineArn: SM_ARN,
            account: '123456789012',
            callerArn: 'arn:aws:sts::123456789012:assumed-role/Admin/jo',
        });
        expect(deps.logErr).toHaveBeenCalledWith(
            '[aws] account 123456789012, region us-east-1',
        );
    });

    test('account guard: refuses when the caller account differs from the pipeline account', async () => {
        const deps = makeDeps({
            createSsm: ssmOk,
            createSts: () => stsFor('999999999999'),
        });
        await expect(
            resolvePipeline('dev-demo', 'us-east-1', deps),
        ).rejects.toThrow(
            /signed in to AWS account 999999999999.*lives in account 123456789012.*ari credentials/s,
        );
        expect(deps.logErr).not.toHaveBeenCalled();
    });
});

describe('startPipelineRun', () => {
    test('starts with name = runId and input { runId }', async () => {
        const sfn = fakeClient({
            StartExecutionCommand: [
                { executionArn: EXEC_ARN, startDate: new Date() },
            ],
        });
        await startPipelineRun(SM_ARN, 'run-1', 'us-east-1', {
            createSfn: () => sfn,
        });
        expect(sfn.calls[0].input).toMatchObject({
            stateMachineArn: SM_ARN,
            name: 'run-1',
            input: JSON.stringify({ runId: 'run-1' }),
        });
    });

    test('ExecutionAlreadyExists becomes a friendly error suggesting <id>-2', async () => {
        const sfn = fakeClient({
            StartExecutionCommand: [err('ExecutionAlreadyExists')],
        });
        await expect(
            startPipelineRun(SM_ARN, 'run-1', 'us-east-1', {
                createSfn: () => sfn,
            }),
        ).rejects.toThrow(/already exists.*--run-id run-1-2/s);
    });
});

describe('listPipelineRuns', () => {
    const ex = (name, status) => ({
        name,
        executionArn: `${EXEC_ARN}:${name}`,
        status,
        startDate: new Date(),
        input: 'SENTINEL_INPUT',
    });

    test('maps runs, passes the status filter, never returns input/output', async () => {
        const sfn = fakeClient({
            ListExecutionsCommand: [
                { executions: [ex('a', 'FAILED'), ex('b', 'FAILED')] },
            ],
        });
        const { runs, truncated } = await listPipelineRuns(
            SM_ARN,
            { status: 'FAILED', limit: 20 },
            'us-east-1',
            { createSfn: () => sfn },
        );
        expect(sfn.calls[0].input.statusFilter).toBe('FAILED');
        expect(runs.map((r) => r.runId)).toEqual(['a', 'b']);
        expect(truncated).toBe(false);
        expect(JSON.stringify(runs)).not.toContain('SENTINEL');
    });

    test('--limit caps results and reports truncation', async () => {
        const sfn = fakeClient({
            ListExecutionsCommand: [
                {
                    executions: [ex('a', 'RUNNING'), ex('b', 'RUNNING')],
                    nextToken: 'more',
                },
            ],
        });
        const { runs, truncated } = await listPipelineRuns(
            SM_ARN,
            { limit: 2 },
            'us-east-1',
            {
                createSfn: () => sfn,
            },
        );
        expect(runs).toHaveLength(2);
        expect(truncated).toBe(true);
        expect(sfn.calls).toHaveLength(1);
    });

    test('--all follows nextToken', async () => {
        const sfn = fakeClient({
            ListExecutionsCommand: [
                { executions: [ex('a', 'SUCCEEDED')], nextToken: 't1' },
                { executions: [ex('b', 'SUCCEEDED')] },
            ],
        });
        const { runs } = await listPipelineRuns(
            SM_ARN,
            { all: true },
            'us-east-1',
            {
                createSfn: () => sfn,
            },
        );
        expect(runs.map((r) => r.runId)).toEqual(['a', 'b']);
        expect(sfn.calls[1].input.nextToken).toBe('t1');
    });
});

describe('stopPipelineRun / getExecutionHistory', () => {
    test('StopExecution carries error StoppedByOperator and the derived execution ARN', async () => {
        const sfn = fakeClient({ StopExecutionCommand: [{}] });
        await stopPipelineRun(SM_ARN, 'run-1', 'because', 'us-east-1', {
            createSfn: () => sfn,
        });
        expect(sfn.calls[0].input).toEqual({
            executionArn: EXEC_ARN,
            error: 'StoppedByOperator',
            cause: 'because',
        });
    });

    test('history is paginated and asks Step Functions to omit execution data', async () => {
        const sfn = fakeClient({
            GetExecutionHistoryCommand: [
                { events: [{ id: 1 }], nextToken: 'n' },
                { events: [{ id: 2 }] },
            ],
        });
        const events = await getExecutionHistory(SM_ARN, 'run-1', 'us-east-1', {
            createSfn: () => sfn,
        });
        expect(events).toEqual([{ id: 1 }, { id: 2 }]);
        expect(
            sfn.calls.every((c) => c.input.includeExecutionData === false),
        ).toBe(true);
    });

    test('unknown execution gives a friendly error', async () => {
        const sfn = fakeClient({
            GetExecutionHistoryCommand: [err('ExecutionDoesNotExist')],
        });
        await expect(
            getExecutionHistory(SM_ARN, 'bogus', 'us-east-1', {
                createSfn: () => sfn,
            }),
        ).rejects.toThrow(/No execution found for run "bogus"/);
    });
});

describe('waitForExecution', () => {
    const wait = (describeSeq, opts = {}, depsOverrides = {}) => {
        const sfn = fakeClient({
            DescribeExecutionCommand: describeSeq,
            GetExecutionHistoryCommand: () => history('extract-text'),
        });
        const deps = makeDeps({ createSfn: () => sfn, ...depsOverrides });
        return {
            sfn,
            deps,
            promise: waitForExecution(EXEC_ARN, opts, 'us-east-1', deps),
        };
    };

    test.each([
        ['SUCCEEDED', 0],
        ['FAILED', 10],
        ['TIMED_OUT', 11],
        ['ABORTED', 12],
    ])('%s maps to exit code %i', async (status, code) => {
        const { promise, deps } = wait([running, { ...running, status }]);
        const result = await promise;
        expect(result).toMatchObject({
            outcome: 'done',
            status,
            exitCode: code,
        });
        expect(deps.sleeps).toEqual([5000]);
    });

    test('reports progress on state change and not on identical polls', async () => {
        const onProgress = jest.fn();
        const { promise } = wait(
            [running, running, { ...running, status: 'SUCCEEDED' }],
            { onProgress },
        );
        await promise;
        expect(onProgress.mock.calls.map(([p]) => [p.status, p.state])).toEqual(
            [
                ['RUNNING', 'extract-text'],
                ['SUCCEEDED', null],
            ],
        );
        expect(onProgress.mock.calls[0][0].elapsedSec).toBe(12);
    });

    test('emits a heartbeat at least every 60s even if nothing changed', async () => {
        const onProgress = jest.fn();
        const seq = Array(14)
            .fill(running)
            .concat({ ...running, status: 'SUCCEEDED' });
        const { promise } = wait(seq, { onProgress, intervalSec: 5 });
        await promise;
        // first line + a heartbeat after 60s (12 polls * 5s) + final
        expect(onProgress.mock.calls.length).toBe(3);
    });

    test('--timeout gives up with exit 3 while still RUNNING, without stopping the run', async () => {
        const { promise, sfn } = wait([running], {
            intervalSec: 5,
            timeoutSec: 12,
        });
        const result = await promise;
        expect(result).toMatchObject({
            outcome: 'timeout',
            exitCode: 3,
            status: 'RUNNING',
        });
        expect(sfn.calls.some((c) => c.type === 'StopExecutionCommand')).toBe(
            false,
        );
    });

    test('transient errors back off exponentially (x2, cap 60s) and recover', async () => {
        const throttle = err('ThrottlingException');
        const { promise, deps } = wait(
            [
                throttle,
                throttle,
                throttle,
                throttle,
                { ...running, status: 'SUCCEEDED' },
            ],
            { intervalSec: 5 },
        );
        const result = await promise;
        expect(result.exitCode).toBe(0);
        expect(deps.sleeps).toEqual([10_000, 20_000, 40_000, 60_000]);
    });

    test('gives up with a plain error after 5 consecutive transient failures', async () => {
        const { promise } = wait([err('ThrottlingException')]);
        await expect(promise).rejects.toThrow(/5 consecutive transient/);
    });

    test('a successful poll resets the transient-failure count', async () => {
        const t = err('ThrottlingException');
        const { promise } = wait([
            t,
            t,
            t,
            t,
            running,
            t,
            t,
            t,
            t,
            { ...running, status: 'SUCCEEDED' },
        ]);
        await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    });

    test('non-transient errors (access denied) propagate immediately', async () => {
        const { promise } = wait([err('AccessDeniedException')]);
        await expect(promise).rejects.toThrow('AccessDeniedException');
    });

    test('expired credentials: rebuilds the client and retries once, then continues', async () => {
        const stale = fakeClient({
            DescribeExecutionCommand: [err('ExpiredTokenException')],
            GetExecutionHistoryCommand: () => history(),
        });
        const fresh = fakeClient({
            DescribeExecutionCommand: [{ ...running, status: 'SUCCEEDED' }],
            GetExecutionHistoryCommand: () => history(),
        });
        const createSfn = jest
            .fn()
            .mockReturnValueOnce(stale)
            .mockReturnValue(fresh);
        const deps = makeDeps({ createSfn });
        const result = await waitForExecution(EXEC_ARN, {}, 'us-east-1', deps);
        expect(createSfn).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ outcome: 'done', exitCode: 0 });
        expect(deps.sleeps).toEqual([]); // retried immediately, no wait
    });

    test('still expired after the rebuild: exit 4, last known status kept, run untouched', async () => {
        const first = fakeClient({
            DescribeExecutionCommand: [running],
            GetExecutionHistoryCommand: () => history('filter-run'),
        });
        const expired = fakeClient({
            DescribeExecutionCommand: [err('UnrecognizedClientException')],
            GetExecutionHistoryCommand: () => history(),
        });
        const createSfn = jest
            .fn()
            .mockReturnValueOnce(first)
            .mockReturnValue(expired);
        // first poll fine (RUNNING), then expiry twice in a row
        first.send.mockImplementation(async (cmd) => {
            if (cmd.constructor.name === 'DescribeExecutionCommand') {
                if (
                    first.calls.filter(
                        (c) => c.type === 'DescribeExecutionCommand',
                    ).length > 0
                ) {
                    throw err('ExpiredTokenException');
                }
                first.calls.push({ type: 'DescribeExecutionCommand' });
                return running;
            }
            return history('filter-run');
        });
        const deps = makeDeps({ createSfn });
        const result = await waitForExecution(EXEC_ARN, {}, 'us-east-1', deps);
        expect(result).toMatchObject({
            outcome: 'expired',
            exitCode: 4,
            status: 'RUNNING',
        });
        const all = [...first.calls, ...expired.calls];
        expect(all.some((c) => c.type === 'StopExecutionCommand')).toBe(false);
    });

    test('Ctrl-C stops waiting only: exit 130, no StopExecution, handler removed', async () => {
        const sfn = fakeClient({
            DescribeExecutionCommand: [running],
            GetExecutionHistoryCommand: () => history('extract-text'),
        });
        const deps = makeDeps({ createSfn: () => sfn });
        // The first sleep is where the user hits Ctrl-C.
        deps.sleep.mockImplementation(() => {
            deps.sigint();
            return new Promise(() => {}); // never resolves; interrupt must win the race
        });
        const result = await waitForExecution(EXEC_ARN, {}, 'us-east-1', deps);
        expect(result).toMatchObject({
            outcome: 'interrupted',
            exitCode: 130,
            status: 'RUNNING',
        });
        expect(sfn.calls.map((c) => c.type)).not.toContain(
            'StopExecutionCommand',
        );
        expect(deps.hasSigintHandler()).toBe(false);
        expect(deps.exit).not.toHaveBeenCalled();
    });

    test('a second Ctrl-C exits the process immediately with 130', async () => {
        const sfn = fakeClient({
            DescribeExecutionCommand: [running],
            GetExecutionHistoryCommand: () => history(),
        });
        const deps = makeDeps({ createSfn: () => sfn });
        deps.sleep.mockImplementation(() => {
            deps.sigint();
            deps.sigint();
            return new Promise(() => {});
        });
        await waitForExecution(EXEC_ARN, {}, 'us-east-1', deps);
        expect(deps.exit).toHaveBeenCalledWith(130);
    });
});

describe('waitForExecution with the real (default) sleep under fake timers', () => {
    beforeEach(() => jest.useFakeTimers());

    test('polls on the interval and resolves when the run finishes', async () => {
        const sfn = fakeClient({
            DescribeExecutionCommand: [
                running,
                running,
                { ...running, status: 'SUCCEEDED' },
            ],
            GetExecutionHistoryCommand: () => history('a'),
        });
        const promise = waitForExecution(
            EXEC_ARN,
            { intervalSec: 5 },
            'us-east-1',
            {
                createSfn: () => sfn,
                onSigint: () => () => {},
            },
        );
        await jest.advanceTimersByTimeAsync(5000);
        expect(
            sfn.calls.filter((c) => c.type === 'DescribeExecutionCommand'),
        ).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(5000);
        await expect(promise).resolves.toMatchObject({ exitCode: 0 });
        jest.useRealTimers();
    });
});

describe('Step Functions logs', () => {
    const smWithLogs = (extra = {}) =>
        fakeClient({
            DescribeStateMachineCommand: [
                {
                    loggingConfiguration: {
                        level: 'ALL',
                        destinations: [
                            {
                                cloudWatchLogsLogGroup: {
                                    logGroupArn:
                                        'arn:aws:logs:us-east-1:123456789012:log-group:/aws/vendedlogs/states/dev-demo-pipeline:*',
                                },
                            },
                        ],
                    },
                    ...extra,
                },
            ],
        });

    test('derives the log group name from the state machine logging config', async () => {
        const name = await getStateMachineLogGroup(SM_ARN, 'us-east-1', {
            createSfn: () => smWithLogs(),
        });
        expect(name).toBe('/aws/vendedlogs/states/dev-demo-pipeline');
    });

    test('errors clearly when logging is off', async () => {
        const sfn = fakeClient({
            DescribeStateMachineCommand: [
                { loggingConfiguration: { level: 'OFF', destinations: [] } },
            ],
        });
        await expect(
            getStateMachineLogGroup(SM_ARN, 'us-east-1', {
                createSfn: () => sfn,
            }),
        ).rejects.toThrow(/no CloudWatch logging/);
    });

    test('filters on the execution ARN, sorts, and respects --limit', async () => {
        const logs = fakeClient({
            FilterLogEventsCommand: [
                {
                    events: [
                        { eventId: 'b', timestamp: 2, message: '{}' },
                        { eventId: 'a', timestamp: 1, message: '{}' },
                        { eventId: 'c', timestamp: 3, message: '{}' },
                    ],
                },
            ],
        });
        const { events, truncated } = await fetchExecutionLogs(
            {
                logGroupName: '/g',
                executionArn: EXEC_ARN,
                startTime: 5,
                limit: 2,
            },
            'us-east-1',
            { createLogs: () => logs },
        );
        expect(events.map((e) => e.eventId)).toEqual(['a', 'b']);
        expect(truncated).toBe(true);
        expect(logs.calls[0].input).toMatchObject({
            logGroupName: '/g',
            filterPattern: `{ $.execution_arn = "${EXEC_ARN}" }`,
            startTime: 5,
        });
    });

    test('a missing log group is a friendly error', async () => {
        const logs = fakeClient({
            FilterLogEventsCommand: [err('ResourceNotFoundException')],
        });
        await expect(
            fetchExecutionLogs(
                { logGroupName: '/g', executionArn: EXEC_ARN },
                'us-east-1',
                {
                    createLogs: () => logs,
                },
            ),
        ).rejects.toThrow(/does not exist/);
    });

    test('refuses an execution ARN that could break out of the filter pattern', async () => {
        await expect(
            fetchExecutionLogs(
                { logGroupName: '/g', executionArn: 'x" || 1=1 "' },
                'us-east-1',
                {
                    createLogs: () => fakeClient(),
                },
            ),
        ).rejects.toThrow(/quotes/);
    });

    test('--follow dedups by eventId and stops once terminal and quiet', async () => {
        const sfn = fakeClient({
            DescribeExecutionCommand: [
                running,
                { ...running, status: 'SUCCEEDED' },
                { ...running, status: 'SUCCEEDED' },
            ],
        });
        const logs = fakeClient({
            FilterLogEventsCommand: [
                { events: [{ eventId: 'a', timestamp: 1, message: '{}' }] },
                {
                    events: [
                        { eventId: 'a', timestamp: 1, message: '{}' },
                        { eventId: 'b', timestamp: 2, message: '{}' },
                    ],
                },
                { events: [{ eventId: 'b', timestamp: 2, message: '{}' }] },
            ],
        });
        const onEvents = jest.fn();
        const deps = makeDeps({ createSfn: () => sfn, createLogs: () => logs });
        const result = await followExecutionLogs(
            {
                logGroupName: '/g',
                executionArn: EXEC_ARN,
                startTime: 0,
                onEvents,
            },
            'us-east-1',
            deps,
        );
        expect(
            onEvents.mock.calls.map(([evs]) => evs.map((e) => e.eventId)),
        ).toEqual([['a'], ['b']]);
        expect(result).toMatchObject({ outcome: 'done', exitCode: 0 });
        expect(deps.sleeps).toEqual([3000, 3000]);
    });

    test('--follow: Ctrl-C returns 130 and credentials expiry returns 4', async () => {
        const sfn = fakeClient({ DescribeExecutionCommand: [running] });
        const logs = fakeClient({ FilterLogEventsCommand: [{ events: [] }] });
        const deps = makeDeps({ createSfn: () => sfn, createLogs: () => logs });
        deps.sleep.mockImplementation(() => {
            deps.sigint();
            return new Promise(() => {});
        });
        const interrupted = await followExecutionLogs(
            {
                logGroupName: '/g',
                executionArn: EXEC_ARN,
                startTime: 0,
                onEvents: jest.fn(),
            },
            'us-east-1',
            deps,
        );
        expect(interrupted.exitCode).toBe(130);

        const expiredSfn = fakeClient({
            DescribeExecutionCommand: [err('ExpiredTokenException')],
        });
        const expired = await followExecutionLogs(
            {
                logGroupName: '/g',
                executionArn: EXEC_ARN,
                startTime: 0,
                onEvents: jest.fn(),
            },
            'us-east-1',
            makeDeps({ createSfn: () => expiredSfn, createLogs: () => logs }),
        );
        expect(expired).toMatchObject({ outcome: 'expired', exitCode: 4 });
    });
});

describe('pipeline manifest', () => {
    const GOOD = {
        schema: 1,
        name: 'dev-demo',
        logGroups: { stateMachine: '/aws/vendedlogs/states/x', lambda: ['/aws/lambda/a', '/aws/lambda/b'] },
    };
    const ssmReturning = (value) =>
        fakeClient({ GetParameterCommand: [{ Parameter: { Value: JSON.stringify(value) } }] });

    test('reads /ari/pipelines/<name>/manifest and returns the parsed schema-1 manifest', async () => {
        const ssm = ssmReturning(GOOD);
        const manifest = await getPipelineManifest('dev-demo', 'us-east-1', { createSsm: () => ssm });
        expect(manifest).toEqual(GOOD);
        expect(ssm.calls[0].input).toEqual({ Name: '/ari/pipelines/dev-demo/manifest' });
    });

    test('an absent parameter is a clear "no manifest, redeploy" error', async () => {
        const ssm = fakeClient({ GetParameterCommand: [err('ParameterNotFound')] });
        await expect(
            getPipelineManifest('dev-demo', 'us-east-1', { createSsm: () => ssm }),
        ).rejects.toThrow(/"dev-demo" has no manifest[\s\S]*redeploy[\s\S]*--source sfn/);
    });

    test.each([
        ['an unknown schema', { ...GOOD, schema: 2 }, /schema 2/],
        ['no lambda log groups', { ...GOOD, logGroups: { lambda: [] } }, /no Lambda log groups/],
        ['non-string log groups', { ...GOOD, logGroups: { lambda: [1] } }, /no Lambda log groups/],
    ])('rejects %s', async (name, value, message) => {
        await expect(
            getPipelineManifest('dev-demo', 'us-east-1', { createSsm: () => ssmReturning(value) }),
        ).rejects.toThrow(message);
    });

    test('other SSM errors (access denied) propagate', async () => {
        const ssm = fakeClient({ GetParameterCommand: [err('AccessDeniedException')] });
        await expect(
            getPipelineManifest('dev-demo', 'us-east-1', { createSsm: () => ssm }),
        ).rejects.toThrow('AccessDeniedException');
    });
});

describe('Lambda logs', () => {
    const REQ = '2f5b3c1e-1111-4222-8333-444455556666';
    const msg = (body) => `2026-10-14T09:00:00.000Z\t${REQ}\tINFO\t${body}`;
    const emf = (runId, over = {}) =>
        msg(JSON.stringify({ _aws: { Timestamp: 1 }, stepId: 'parse-file', runId, fileId: 'SENTINEL_FILE_NAME', StepDuration: 1234, ...over }));
    const GROUPS = ['/aws/lambda/p-datfile-step-runner', '/aws/lambda/p-datarun-step-runner'];

    test('fetchLambdaLogs: reads each group in the window, keeps this run, drops other runs, withholds free text', async () => {
        const logs = fakeClient({
            FilterLogEventsCommand: (input) => ({
                events: input.logGroupName === GROUPS[0]
                    ? [
                        { eventId: 'a', timestamp: 3, message: emf('run-1') },
                        { eventId: 'b', timestamp: 2, message: emf('run-2') },
                        { eventId: 'c', timestamp: 1, message: msg('SENTINEL_PROTECTED_TEXT was parsed') },
                    ]
                    : [{ eventId: 'd', timestamp: 4, message: `START RequestId: ${REQ} Version: $LATEST` }],
            }),
        });
        const { events, truncated } = await fetchLambdaLogs(
            { logGroupNames: GROUPS, runId: 'run-1', startTime: 10, endTime: 20 },
            'us-east-1',
            { createLogs: () => logs },
        );
        expect(logs.calls.map((c) => c.input.logGroupName)).toEqual(GROUPS);
        expect(logs.calls[0].input).toMatchObject({ startTime: 10, endTime: 20 });
        expect(events.map((e) => e.eventId)).toEqual(['c', 'a', 'd']);
        expect(events[0].line).toContain('[line withheld');
        expect(events[1].line).toContain('lambda:datfile-step-runner METRIC step=parse-file duration=1234ms');
        expect(events[2].line).toContain('lambda:datarun-step-runner START');
        expect(truncated).toBe(false);
        const all = JSON.stringify(events);
        expect(all).not.toContain('SENTINEL_PROTECTED_TEXT');
        expect(all).not.toContain('SENTINEL_FILE_NAME');
        expect(all).not.toContain('run-2');
    });

    test('fetchLambdaLogs: respects --limit and follows nextToken', async () => {
        const logs = fakeClient({
            FilterLogEventsCommand: [
                { events: [{ eventId: 'a', timestamp: 1, message: `END RequestId: ${REQ}` }], nextToken: 'n' },
                { events: [{ eventId: 'b', timestamp: 2, message: `END RequestId: ${REQ}` }] },
            ],
        });
        const result = await fetchLambdaLogs(
            { logGroupNames: [GROUPS[0]], runId: 'r', startTime: 0, limit: 1 },
            'us-east-1',
            { createLogs: () => logs },
        );
        expect(result.events).toHaveLength(1);
        expect(result.truncated).toBe(true);
    });

    test('fetchLambdaLogs: a missing group is a friendly error', async () => {
        const logs = fakeClient({ FilterLogEventsCommand: [err('ResourceNotFoundException')] });
        await expect(
            fetchLambdaLogs({ logGroupNames: GROUPS, runId: 'r', startTime: 0 }, 'us-east-1', { createLogs: () => logs }),
        ).rejects.toThrow(/does not exist/);
    });

    test('--follow over lambda + sfn sources: dedup, other runs dropped, stops when terminal and quiet', async () => {
        const sfn = fakeClient({
            DescribeExecutionCommand: [running, { ...running, status: 'SUCCEEDED' }, { ...running, status: 'SUCCEEDED' }],
        });
        const logs = fakeClient({
            FilterLogEventsCommand: (input) => {
                if (input.logGroupName === '/sfn') {
                    return { events: [{ eventId: 's', timestamp: 1, message: JSON.stringify({ type: 'ExecutionStarted' }) }] };
                }
                return {
                    events: [
                        { eventId: 'm1', timestamp: 2, message: emf('run-1') },
                        { eventId: 'm2', timestamp: 3, message: emf('other-run') },
                    ],
                };
            },
        });
        const deps = makeDeps({ createSfn: () => sfn, createLogs: () => logs });
        const onEvents = jest.fn();
        const result = await followExecutionLogs(
            {
                executionArn: EXEC_ARN,
                startTime: 0,
                onEvents,
                sources: [
                    sfnLogSource('/sfn', EXEC_ARN),
                    ...lambdaLogSources([GROUPS[0]], 'run-1'),
                ],
            },
            'us-east-1',
            deps,
        );
        const lines = onEvents.mock.calls.flatMap(([evs]) => evs.map((e) => e.line));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('ExecutionStarted');
        expect(lines[1]).toContain('METRIC step=parse-file');
        expect(result).toMatchObject({ outcome: 'done', exitCode: 0 });
        const sfnCall = logs.calls.find((c) => c.input.logGroupName === '/sfn');
        expect(sfnCall.input.filterPattern).toBe(`{ $.execution_arn = "${EXEC_ARN}" }`);
        const lambdaCall = logs.calls.find((c) => c.input.logGroupName === GROUPS[0]);
        expect(lambdaCall.input.filterPattern).toBeUndefined();
    });
});

describe('resolveDataPipeline (manifest + accountKey guard)', () => {
    const SM = DATA_MANIFEST.stateMachineArn; // account 123456789012
    const ssmWith = (manifest) => ({
        send: jest.fn(async (command) => {
            const name = command.input.Name;
            if (name.endsWith('/stateMachineArn')) return { Parameter: { Value: SM } };
            if (manifest instanceof Error) throw manifest;
            return { Parameter: { Value: JSON.stringify(manifest) } };
        }),
        calls: [],
    });
    const sts = (Account) =>
        fakeClient({ GetCallerIdentityCommand: [{ Account, Arn: 'arn:aws:sts::' + Account + ':assumed-role/Admin/jo' }] });
    const localConfig = (accounts) => () => ({ accounts });
    const deps = (over = {}) =>
        makeDeps({
            createSsm: () => ssmWith(DATA_MANIFEST),
            createSts: () => sts('123456789012'),
            readLocalConfig: localConfig({ controlled: { accountId: '123456789012' } }),
            ...over,
        });

    test('returns the validated manifest and prints [aws] account <id> (<accountKey>)', async () => {
        const d = deps();
        const r = await resolveDataPipeline('dev-demo', 'us-east-1', d);
        expect(r.manifest).toEqual(DATA_MANIFEST);
        expect(r.accountKey).toBe('controlled');
        expect(d.logErr).toHaveBeenCalledWith('[aws] account 123456789012 (controlled), region us-east-1');
    });

    test('caller account != state machine ARN account -> refused (even before the manifest is read)', async () => {
        const d = deps({ createSts: () => sts('999999999999') });
        await expect(resolveDataPipeline('dev-demo', 'us-east-1', d)).rejects.toThrow(/999999999999.*lives in account 123456789012/s);
        expect(d.logErr).not.toHaveBeenCalled();
    });

    test('manifest accountKey != ~/.ari/config.json mapping -> refused with ari credentials -a <accountKey>', async () => {
        const d = deps({ readLocalConfig: localConfig({ controlled: { accountId: '555555555555' } }) });
        await expect(resolveDataPipeline('dev-demo', 'us-east-1', d)).rejects.toThrow(
            /belongs to the "controlled" account \(555555555555\).*ari credentials -a controlled/s,
        );
        expect(d.logErr).not.toHaveBeenCalled();
    });

    test('accountKey with no local mapping fails closed (run ari init), also with no local config at all', async () => {
        await expect(
            resolveDataPipeline('dev-demo', 'us-east-1', deps({ readLocalConfig: localConfig({}) })),
        ).rejects.toThrow(/no account id for it.*ari init/s);
        await expect(
            resolveDataPipeline('dev-demo', 'us-east-1', deps({ readLocalConfig: () => null })),
        ).rejects.toThrow(/ari init/);
    });

    test('a manifest without accountKey is guarded by the state machine ARN account only', async () => {
        const { accountKey: _k, ...noKey } = DATA_MANIFEST;
        const d = deps({ createSsm: () => ssmWith(noKey), readLocalConfig: () => null });
        const r = await resolveDataPipeline('dev-demo', 'us-east-1', d);
        expect(r.accountKey).toBeUndefined();
        expect(d.logErr).toHaveBeenCalledWith('[aws] account 123456789012, region us-east-1');
    });

    test('no manifest -> legacy message pointing at redeploy; control-plane resolvePipeline is unaffected', async () => {
        const d = deps({ createSsm: () => ssmWith(err('ParameterNotFound')) });
        await expect(resolveDataPipeline('dev-demo', 'us-east-1', d)).rejects.toThrow(
            /"dev-demo" has no manifest.*redeploy.*ari pipeline data/s,
        );
        const plain = await resolvePipeline('dev-demo', 'us-east-1', deps({ createSsm: () => ssmWith(err('ParameterNotFound')) }));
        expect(plain.manifest).toBeUndefined();
    });

    test('unknown schema and invalid manifests are clear errors', async () => {
        await expect(
            resolveDataPipeline('dev-demo', 'us-east-1', deps({ createSsm: () => ssmWith({ ...DATA_MANIFEST, schema: 2 }) })),
        ).rejects.toThrow(/schema 2.*Update ari-cli/s);
        await expect(
            resolveDataPipeline('dev-demo', 'us-east-1', deps({ createSsm: () => ssmWith({ ...DATA_MANIFEST, stages: [] }) })),
        ).rejects.toThrow(/invalid/);
    });

    test('a manifest naming a different state machine than the registry is refused', async () => {
        const other = { ...DATA_MANIFEST, stateMachineArn: SM.replace('dev-demo-pipeline', 'other-pipeline') };
        await expect(
            resolveDataPipeline('dev-demo', 'us-east-1', deps({ createSsm: () => ssmWith(other) })),
        ).rejects.toThrow(/different state machine/);
    });
});

describe('data plane S3 calls', () => {
    const body = (text) => Readable.from([Buffer.from(text)]);
    const M = DATA_MANIFEST;

    test('listDataObjects: prefix from the manifest, pagination, --match, bare ids', async () => {
        const s3 = fakeClient({
            ListObjectsV2Command: [
                { Contents: [{ Key: 'chunks/r1/A.pdf/p1.txt', Size: 10 }, { Key: 'chunks/r1/', Size: 0 }], NextContinuationToken: 't' },
                { Contents: [{ Key: 'chunks/r1/b.pdf/p1.txt', Size: 20 }] },
            ],
        });
        const objs = await listDataObjects(M, 'chunks', 'r1', { match: 'a.pdf' }, 'us-east-1', { createS3: () => s3 });
        expect(objs.map((o) => o.id)).toEqual(['A.pdf/p1.txt']);
        expect(s3.calls[0].input).toMatchObject({ Bucket: 'dev-demo-pipeline', Prefix: 'chunks/r1/' });
        expect(s3.calls[1].input.ContinuationToken).toBe('t');
    });

    test('listDataObjects rejects stages that are not in the manifest, without calling S3', async () => {
        const s3 = fakeClient({});
        await expect(listDataObjects(M, '../etc', 'r1', {}, 'us-east-1', { createS3: () => s3 })).rejects.toThrow(/Unknown stage/);
        expect(s3.calls).toHaveLength(0);
    });

    test('S3 AccessDenied becomes a friendly error naming the role fix', async () => {
        const s3 = fakeClient({ ListObjectsV2Command: [err('AccessDenied')] });
        await expect(listDataObjects(M, 'raw', 'r1', {}, 'us-east-1', { createS3: () => s3 })).rejects.toThrow(/access denied.*AdministratorAccess/s);
    });

    test('dataPrefixHasObjects uses MaxKeys 1', async () => {
        const s3 = fakeClient({ ListObjectsV2Command: [{ Contents: [{ Key: 'raw/r1/x' }] }] });
        expect(await dataPrefixHasObjects(M, 'raw', 'r1', 'us-east-1', { createS3: () => s3 })).toBe(true);
        expect(s3.calls[0].input.MaxKeys).toBe(1);
    });

    describe('local files + upload', () => {
        let dir;
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-load-'));
        });
        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

        test('top-level files only (not recursive), sorted; empty dir is an error', () => {
            fs.writeFileSync(path.join(dir, 'b.pdf'), 'B');
            fs.writeFileSync(path.join(dir, 'a.pdf'), 'A');
            fs.mkdirSync(path.join(dir, 'sub'));
            fs.writeFileSync(path.join(dir, 'sub', 'c.pdf'), 'C');
            expect(listLocalFiles(dir)).toEqual(['a.pdf', 'b.pdf']);
            const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-empty-'));
            expect(() => listLocalFiles(empty)).toThrow(/No files found/);
            fs.rmdirSync(empty);
            expect(() => listLocalFiles(path.join(dir, 'missing'))).toThrow(/Cannot read directory/);
        });

        test('uploadDataFiles puts each file at <stage>/<runId>/<name> and returns counts', async () => {
            fs.writeFileSync(path.join(dir, 'a.pdf'), 'AAAA');
            fs.writeFileSync(path.join(dir, 'b.pdf'), 'BB');
            const s3 = fakeClient({ PutObjectCommand: () => ({}) });
            const seen = [];
            const r = await uploadDataFiles(
                M,
                { stage: 'raw', runId: 'r1', localDir: dir, fileNames: ['a.pdf', 'b.pdf'], onFile: (n) => seen.push(n) },
                'us-east-1',
                { createS3: () => s3 },
            );
            expect(r).toEqual({ count: 2, bytes: 6 });
            expect(seen).toEqual(['a.pdf', 'b.pdf']);
            expect(s3.calls.map((c) => c.input.Key)).toEqual(['raw/r1/a.pdf', 'raw/r1/b.pdf']);
            expect(s3.calls[0].input.Bucket).toBe('dev-demo-pipeline');
        });
    });

    test('headDataObject returns metadata only; missing objects are a clean error', async () => {
        const s3 = fakeClient({
            HeadObjectCommand: [{ ContentLength: 12, VersionId: 'v9', ContentType: 'text/csv', LastModified: new Date(0) }],
        });
        expect(await headDataObject(M, 'final', 'r1', 'final.csv', 'us-east-1', { createS3: () => s3 })).toMatchObject({
            key: 'final/r1/final.csv', size: 12, versionId: 'v9',
        });
        const missing = fakeClient({ HeadObjectCommand: [err('NotFound')] });
        await expect(headDataObject(M, 'final', 'r1', 'x', 'us-east-1', { createS3: () => missing })).rejects.toThrow(/no such object/);
    });

    test('readDataObject: ranged request caps the transfer and pins the version', async () => {
        const s3 = fakeClient({ GetObjectCommand: [{ Body: body('hello') }] });
        const buf = await readDataObject(M, 'chunks', 'r1', 'a.txt', { versionId: 'v1', maxBytes: 100 }, 'us-east-1', { createS3: () => s3 });
        expect(buf.toString()).toBe('hello');
        expect(s3.calls[0].input).toMatchObject({ Key: 'chunks/r1/a.txt', Range: 'bytes=0-99', VersionId: 'v1' });
    });

    test('readDataObject refuses a body larger than the limit even if the server ignores Range', async () => {
        const s3 = fakeClient({ GetObjectCommand: [{ Body: body('x'.repeat(50)) }] });
        await expect(
            readDataObject(M, 'chunks', 'r1', 'a.txt', { maxBytes: 10 }, 'us-east-1', { createS3: () => s3 }),
        ).rejects.toThrow(/larger than the 10-byte/);
    });

    test('readDataObject without maxBytes sends no Range (inspect reads whole objects)', async () => {
        const s3 = fakeClient({ GetObjectCommand: [{ Body: body('x') }] });
        await readDataObject(M, 'final', 'r1', 'final.csv', {}, 'us-east-1', { createS3: () => s3 });
        expect(s3.calls[0].input.Range).toBeUndefined();
    });

    test('downloadDataObject writes a 0600 file and refuses to overwrite without force', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-dl-'));
        try {
            const out = path.join(dir, 'f.csv');
            const mk = () => fakeClient({ GetObjectCommand: () => ({ Body: body('a,b\n1,2\n') }) });
            const r = await downloadDataObject(M, 'final', 'r1', 'final.csv', out, { versionId: 'v1' }, 'us-east-1', { createS3: mk });
            expect(r.bytes).toBe(8);
            expect(fs.statSync(out).mode & 0o777).toBe(0o600);
            await expect(
                downloadDataObject(M, 'final', 'r1', 'final.csv', out, {}, 'us-east-1', { createS3: mk }),
            ).rejects.toThrow(/already exists/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
