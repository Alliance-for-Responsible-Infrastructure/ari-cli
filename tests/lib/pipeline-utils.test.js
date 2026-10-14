/**
 * Tests for the pure helpers behind `ari pipeline`: durations, error
 * classification, the history fold (allow-listing!) and log-line rendering.
 */
import { describe, expect, test } from '@jest/globals';
import {
    EXIT,
    PipelineError,
    parseDuration,
    formatDuration,
    formatElapsed,
    isExpiredCreds,
    isTransient,
    foldHistory,
    formatSfnLogEvent,
    classifyLambdaLogEvent,
    lambdaLabels,
    formatLambdaLogLine,
    truncate,
} from '#src/lib/cli/pipeline-utils.js';

describe('parseDuration', () => {
    test.each([
        ['90s', 90],
        ['15m', 900],
        ['2h', 7200],
        ['1d', 86400],
        ['45', 45],
    ])('parses %s', (input, seconds) => {
        expect(parseDuration(input)).toBe(seconds);
    });

    test('"none" and undefined mean no limit', () => {
        expect(parseDuration('none')).toBeNull();
        expect(parseDuration(undefined)).toBeNull();
    });

    test.each(['abc', '-5m', '0s', '1.5h', '10x'])(
        'rejects %s with a usage error (exit 2)',
        (input) => {
            expect.assertions(2);
            try {
                parseDuration(input);
            } catch (e) {
                expect(e).toBeInstanceOf(PipelineError);
                expect(e.exitCode).toBe(EXIT.USAGE);
            }
        },
    );
});

describe('formatting', () => {
    test('formatDuration', () => {
        expect(formatDuration(1.24)).toBe('1.2s');
        expect(formatDuration(41)).toBe('41s');
        expect(formatDuration(389)).toBe('6m 29s');
        expect(formatDuration(3720)).toBe('1h 02m');
        expect(formatDuration(null)).toBe('-');
    });

    test('formatElapsed', () => {
        expect(formatElapsed(12)).toBe('00:00:12');
        expect(formatElapsed(1143)).toBe('00:19:03');
        expect(formatElapsed(-3)).toBe('00:00:00');
    });

    test('truncate', () => {
        expect(truncate('abcdef', 3)).toBe('abc...');
        expect(truncate('abc', 3)).toBe('abc');
    });
});

describe('error classifiers', () => {
    test.each([
        'ExpiredTokenException',
        'ExpiredToken',
        'UnrecognizedClientException',
        'InvalidClientTokenId',
    ])('%s is expired credentials, not transient', (name) => {
        expect(isExpiredCreds({ name })).toBe(true);
        expect(isTransient({ name })).toBe(false);
    });

    test('throttling, 5xx and network errors are transient', () => {
        expect(isTransient({ name: 'ThrottlingException' })).toBe(true);
        expect(
            isTransient({ name: 'X', $metadata: { httpStatusCode: 503 } }),
        ).toBe(true);
        expect(isTransient({ name: 'Error', code: 'ECONNRESET' })).toBe(true);
    });

    test('access denied and unknown errors are neither', () => {
        const e = {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 400 },
        };
        expect(isTransient(e)).toBe(false);
        expect(isExpiredCreds(e)).toBe(false);
        expect(isTransient(undefined)).toBe(false);
    });
});

const T0 = new Date('2026-10-14T09:00:00.000Z');
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const SENTINELS = [
    'SENTINEL_INPUT',
    'SENTINEL_OUTPUT',
    'SENTINEL_CAUSE',
    'SENTINEL_MAP_ITEM',
];

// A run: extract-text ok -> Map(process-files, 2 items) whose first iteration
// retries parse-file once and succeeds and whose second fails -> ExecutionFailed.
function fixtureEvents() {
    return [
        {
            id: 1,
            previousEventId: 0,
            type: 'ExecutionStarted',
            timestamp: at(0),
            executionStartedEventDetails: { input: 'SENTINEL_INPUT' },
        },
        {
            id: 2,
            previousEventId: 0,
            type: 'TaskStateEntered',
            timestamp: at(0),
            stateEnteredEventDetails: {
                name: 'extract-text',
                input: 'SENTINEL_INPUT',
            },
        },
        { id: 3, previousEventId: 2, type: 'TaskScheduled', timestamp: at(0) },
        { id: 4, previousEventId: 3, type: 'TaskStarted', timestamp: at(1) },
        {
            id: 5,
            previousEventId: 4,
            type: 'TaskSucceeded',
            timestamp: at(60),
            taskSucceededEventDetails: { output: 'SENTINEL_OUTPUT' },
        },
        {
            id: 6,
            previousEventId: 5,
            type: 'TaskStateExited',
            timestamp: at(60),
            stateExitedEventDetails: {
                name: 'extract-text',
                output: 'SENTINEL_OUTPUT',
            },
        },
        {
            id: 7,
            previousEventId: 6,
            type: 'MapStateEntered',
            timestamp: at(61),
            stateEnteredEventDetails: {
                name: 'process-files',
                input: 'SENTINEL_MAP_ITEM',
            },
        },
        {
            id: 8,
            previousEventId: 7,
            type: 'MapStateStarted',
            timestamp: at(61),
            mapStateStartedEventDetails: { length: 2 },
        },
        {
            id: 9,
            previousEventId: 8,
            type: 'MapIterationStarted',
            timestamp: at(61),
            mapIterationStartedEventDetails: {
                name: 'process-files',
                index: 0,
            },
        },
        {
            id: 10,
            previousEventId: 8,
            type: 'MapIterationStarted',
            timestamp: at(61),
            mapIterationStartedEventDetails: {
                name: 'process-files',
                index: 1,
            },
        },
        {
            id: 11,
            previousEventId: 9,
            type: 'TaskStateEntered',
            timestamp: at(62),
            stateEnteredEventDetails: {
                name: 'parse-file',
                input: 'SENTINEL_MAP_ITEM',
            },
        },
        {
            id: 12,
            previousEventId: 11,
            type: 'TaskScheduled',
            timestamp: at(62),
        },
        {
            id: 13,
            previousEventId: 12,
            type: 'TaskFailed',
            timestamp: at(70),
            taskFailedEventDetails: {
                error: 'THROTTLED',
                cause: 'SENTINEL_CAUSE',
            },
        },
        {
            id: 14,
            previousEventId: 13,
            type: 'TaskScheduled',
            timestamp: at(75),
        },
        {
            id: 15,
            previousEventId: 14,
            type: 'TaskSucceeded',
            timestamp: at(100),
            taskSucceededEventDetails: { output: 'SENTINEL_OUTPUT' },
        },
        {
            id: 16,
            previousEventId: 15,
            type: 'TaskStateExited',
            timestamp: at(102),
            stateExitedEventDetails: {
                name: 'parse-file',
                output: 'SENTINEL_OUTPUT',
            },
        },
        {
            id: 17,
            previousEventId: 10,
            type: 'TaskStateEntered',
            timestamp: at(62),
            stateEnteredEventDetails: {
                name: 'parse-file',
                input: 'SENTINEL_MAP_ITEM',
            },
        },
        {
            id: 18,
            previousEventId: 17,
            type: 'TaskScheduled',
            timestamp: at(62),
        },
        {
            id: 19,
            previousEventId: 18,
            type: 'TaskFailed',
            timestamp: at(80),
            taskFailedEventDetails: {
                error: 'INVALID_JSON_FROM_MODEL',
                cause: 'SENTINEL_CAUSE',
            },
        },
        {
            id: 20,
            previousEventId: 16,
            type: 'MapIterationSucceeded',
            timestamp: at(102),
            mapIterationSucceededEventDetails: {
                name: 'process-files',
                index: 0,
            },
        },
        {
            id: 21,
            previousEventId: 19,
            type: 'MapIterationFailed',
            timestamp: at(80),
            mapIterationFailedEventDetails: { name: 'process-files', index: 1 },
        },
        {
            id: 22,
            previousEventId: 21,
            type: 'ExecutionFailed',
            timestamp: at(103),
            executionFailedEventDetails: {
                error: 'INVALID_JSON_FROM_MODEL',
                cause: 'SENTINEL_CAUSE',
            },
        },
    ];
}

describe('foldHistory', () => {
    test('folds events into one row per state with Map iterations summarized', () => {
        const { states, execution } = foldHistory(fixtureEvents());

        expect(states.map((s) => s.name)).toEqual([
            'extract-text',
            'process-files',
            'parse-file',
        ]);
        const [extract, map, parse] = states;

        expect(extract).toMatchObject({
            type: 'Task',
            attempts: 1,
            failures: 0,
            result: 'ok',
            durationSec: 60,
            nested: false,
        });
        expect(map).toMatchObject({
            type: 'Map',
            items: 2,
            iterationsOk: 1,
            iterationsFailed: 1,
        });
        expect(parse).toMatchObject({
            nested: true,
            parent: 'process-files',
            calls: 3,
            retried: 1,
            failures: 2,
            result: 'FAILED',
            error: 'INVALID_JSON_FROM_MODEL',
        });
        expect(execution).toMatchObject({
            status: 'FAILED',
            error: 'INVALID_JSON_FROM_MODEL',
        });
    });

    test('a state that retried but then succeeded is ok, with its attempt count', () => {
        const events = fixtureEvents().filter(
            (e) => ![17, 18, 19, 21].includes(e.id),
        );
        const { states } = foldHistory(events);
        const parse = states.find((s) => s.name === 'parse-file');
        expect(parse).toMatchObject({ calls: 2, retried: 1, result: 'ok' });
    });

    test('NEVER surfaces input, output, Map items or cause by default', () => {
        const folded = foldHistory(fixtureEvents());
        const dump = JSON.stringify(folded);
        for (const sentinel of SENTINELS) {
            expect(dump).not.toContain(sentinel);
        }
    });

    test('includeCause adds a truncated cause (and only the cause)', () => {
        const events = fixtureEvents();
        events[18].taskFailedEventDetails.cause = `SENTINEL_CAUSE${'x'.repeat(500)}`;
        const dump = JSON.stringify(
            foldHistory(events, { includeCause: true }),
        );
        expect(dump).toContain('SENTINEL_CAUSE');
        expect(dump).not.toContain('x'.repeat(301));
        expect(dump).not.toContain('SENTINEL_INPUT');
        expect(dump).not.toContain('SENTINEL_OUTPUT');
        expect(dump).not.toContain('SENTINEL_MAP_ITEM');
    });

    test('an in-progress execution reports RUNNING rows', () => {
        const { states, execution } = foldHistory(fixtureEvents().slice(0, 3));
        expect(states[0].result).toBe('RUNNING');
        expect(execution.status).toBe('RUNNING');
    });
});

describe('formatSfnLogEvent', () => {
    const base = { timestamp: T0.getTime() };

    test('prints only type, state name and error code', () => {
        const message = JSON.stringify({
            type: 'TaskFailed',
            details: {
                name: 'parse-file',
                error: 'INVALID_JSON_FROM_MODEL',
                cause: 'SENTINEL_CAUSE',
                input: 'SENTINEL_INPUT',
                output: 'SENTINEL_OUTPUT',
            },
        });
        const line = formatSfnLogEvent({ ...base, message });
        expect(line).toContain(
            'TaskFailed parse-file error=INVALID_JSON_FROM_MODEL',
        );
        for (const sentinel of SENTINELS) expect(line).not.toContain(sentinel);
    });

    test('non-JSON lines are truncated to 500 chars unless full', () => {
        const message = 'y'.repeat(800);
        expect(formatSfnLogEvent({ ...base, message })).toContain(
            `${'y'.repeat(500)}...`,
        );
        expect(
            formatSfnLogEvent({ ...base, message }, { full: true }),
        ).toContain('y'.repeat(800));
    });
});

describe('classifyLambdaLogEvent (allow-list)', () => {
    const REQ = '2f5b3c1e-1111-4222-8333-444455556666';
    const event = (message) => ({ timestamp: T0.getTime(), message });
    const prefixed = (body, level = 'INFO') => `2026-10-14T09:00:00.000Z\t${REQ}\t${level}\t${body}`;
    const classify = (message, runId = 'run-1') => classifyLambdaLogEvent(event(message), { runId });

    test('platform lines: START / END / REPORT (numbers only)', () => {
        expect(classify(`START RequestId: ${REQ} Version: $LATEST`)).toEqual({ text: 'START' });
        expect(classify(`END RequestId: ${REQ}`)).toEqual({ text: 'END' });
        const report = `REPORT RequestId: ${REQ}\tDuration: 41234.56 ms\tBilled Duration: 41235 ms\tMemory Size: 512 MB\tMax Memory Used: 211 MB\tInit Duration: 310.12 ms\n`;
        expect(classify(report)).toEqual({
            text: 'REPORT duration=41234.56ms billed=41235ms memory=211/512MB init=310.12ms',
        });
    });

    test('the EMF metric line (plain JSON or with the runtime prefix) prints step + duration only, for this run', () => {
        const body = JSON.stringify({
            _aws: { Timestamp: 1 }, stepId: 'verify-file', runId: 'run-1', fileId: 'SENTINEL_FILE_NAME', StepDuration: 23000.4,
        });
        for (const message of [body, prefixed(body)]) {
            const result = classify(message);
            expect(result.text).toBe('METRIC step=verify-file duration=23000ms');
            expect(result.text).not.toContain('SENTINEL_FILE_NAME');
        }
    });

    test('an EMF line for another run is dropped (null)', () => {
        const body = JSON.stringify({ _aws: {}, stepId: 'x', runId: 'other', StepDuration: 1 });
        expect(classify(prefixed(body))).toBeNull();
    });

    test('an unsafe stepId is not echoed', () => {
        const body = JSON.stringify({ _aws: {}, stepId: 'SENTINEL text with spaces', runId: 'run-1', StepDuration: 1 });
        expect(classify(body).text).toBe('METRIC step=? duration=1ms');
    });

    test('runtime Invoke Error prints the error code only -- never errorMessage or stack', () => {
        const body = `Invoke Error \t${JSON.stringify({
            errorType: 'INVALID_JSON_FROM_MODEL',
            errorMessage: 'SENTINEL_PROTECTED_TEXT',
            stack: ['at SENTINEL_STACK'],
        })}`;
        const result = classify(prefixed(body, 'ERROR'));
        expect(result.text).toBe('ERROR INVALID_JSON_FROM_MODEL');
        expect(JSON.stringify(result)).not.toContain('SENTINEL');
        expect(classify(JSON.stringify({ errorType: 'has spaces and SENTINEL', errorMessage: 'm' })).text).toBe('ERROR (unrecognized type)');
    });

    test('timeouts and runtime exits are reduced to their numbers / signal', () => {
        expect(classify(`2026-10-14T09:00:00.000Z ${REQ} Task timed out after 300.05 seconds`).text).toBe('TIMEOUT after 300.05s');
        expect(classify(`RequestId: ${REQ} Error: Runtime exited with error: signal: killed`).text).toBe('RUNTIME_EXIT signal=killed');
    });

    test.each([
        ['free text', prefixed('parsed SENTINEL_PROTECTED_TEXT')],
        ['a JSON line that is not a recognized shape', prefixed(JSON.stringify({ response: 'SENTINEL_PROTECTED_TEXT' }))],
        ['a START-lookalike with trailing text', `START RequestId: ${REQ} SENTINEL_PROTECTED_TEXT`],
        ['a timeout-lookalike with trailing text', 'Task timed out after 3 seconds SENTINEL_PROTECTED_TEXT'],
        ['a bare JSON string', '"SENTINEL_PROTECTED_TEXT"'],
        ['a JSON array', '["SENTINEL_PROTECTED_TEXT"]'],
        ['null', 'null'],
        ['an empty message', ''],
    ])('withholds %s', (name, message) => {
        const result = classify(message);
        expect(result.text).toMatch(/^\[line withheld/);
        expect(JSON.stringify(result)).not.toContain('SENTINEL_PROTECTED_TEXT');
    });
});

describe('lambdaLabels / formatLambdaLogLine', () => {
    test('strips /aws/lambda/ and the common prefix across groups', () => {
        // (names are clamped by shaving the project name, so they may differ mid-word)
        expect(lambdaLabels(['/aws/lambda/p-datfile-step-runner', '/aws/lambda/p-datarun-step-runner'])).toEqual({
            '/aws/lambda/p-datfile-step-runner': 'datfile-step-runner',
            '/aws/lambda/p-datarun-step-runner': 'datarun-step-runner',
        });
        expect(lambdaLabels(['/aws/lambda/proj-file-step-runner', '/aws/lambda/proj-run-step-runner'])).toEqual({
            '/aws/lambda/proj-file-step-runner': 'file-step-runner',
            '/aws/lambda/proj-run-step-runner': 'run-step-runner',
        });
        expect(lambdaLabels(['/aws/lambda/only-one'])).toEqual({ '/aws/lambda/only-one': 'only-one' });
    });

    test('formats HH:MM:SS lambda:<label> <text>, truncating to 500 unless full', () => {
        const ev = { timestamp: T0.getTime() };
        expect(formatLambdaLogLine(ev, 'x', 'END')).toMatch(/^\d\d:\d\d:\d\d lambda:x END$/);
        const long = 'z'.repeat(800);
        expect(formatLambdaLogLine(ev, 'x', long)).toContain(`${'z'.repeat(400)}`);
        expect(formatLambdaLogLine(ev, 'x', long).length).toBeLessThan(520);
        expect(formatLambdaLogLine(ev, 'x', long, { full: true }).length).toBeGreaterThan(800);
    });
});
