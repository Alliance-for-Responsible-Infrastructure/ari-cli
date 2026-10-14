/**
 * Tests for PipelineRunCommand / PipelineStatusCommand / PipelineDeployCommand
 * — command sequencing and output for `ari pipeline run|status|deploy`. All
 * AWS calls are mocked at the src/lib/cli/pipeline.js layer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    jest,
    describe,
    expect,
    test,
    afterEach,
    beforeEach,
} from '@jest/globals';

jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('child_process', () => ({
    spawnSync: jest.fn(() => ({ status: 0, error: null })),
}));

jest.unstable_mockModule('#src/lib/cli/aws.js', () => ({
    DEFAULT_BOOTSTRAP_QUALIFIER: 'hnb659fds',
    getCallerAccount: jest.fn().mockResolvedValue('123456789012'),
    getBootstrapVersion: jest.fn().mockResolvedValue('21'),
}));

jest.unstable_mockModule('#src/lib/local-config.js', () => ({
    readLocalConfig: jest.fn(() => ({
        accounts: { controlled: { accountId: '123456789012' } },
    })),
}));

const SM_ARN =
    'arn:aws:states:us-east-1:123456789012:stateMachine:dev-bedrock-docs-pipeline';
const EXEC_ARN =
    'arn:aws:states:us-east-1:123456789012:execution:dev-bedrock-docs-pipeline:run-20261004120000-abc123';

jest.unstable_mockModule('#src/lib/cli/prompt.js', () => ({
    isInteractive: jest.fn(() => true),
    confirm: jest.fn().mockResolvedValue(true),
}));

jest.unstable_mockModule('#src/lib/cli/pipeline.js', () => ({
    resolvePipeline: jest.fn().mockResolvedValue({
        stateMachineArn: SM_ARN,
        account: '123456789012',
        callerArn: 'arn:aws:sts::123456789012:assumed-role/Admin/jo',
        region: 'us-east-1',
    }),
    generateRunId: jest.fn(() => 'run-20261004120000-abc123'),
    startPipelineRun: jest.fn().mockResolvedValue({
        executionArn: EXEC_ARN,
        startDate: new Date('2026-10-04T12:00:00.000Z'),
    }),
    describePipelineRun: jest.fn().mockResolvedValue({
        status: 'RUNNING',
        executionArn: EXEC_ARN,
        startDate: new Date('2026-10-04T12:00:00.000Z'),
    }),
    listPipelineRuns: jest.fn(),
    stopPipelineRun: jest.fn().mockResolvedValue(undefined),
    getExecutionHistory: jest.fn(),
    waitForExecution: jest.fn(),
    getStateMachineLogGroup: jest
        .fn()
        .mockResolvedValue('/aws/vendedlogs/states/x'),
    fetchExecutionLogs: jest.fn(),
    followExecutionLogs: jest.fn(),
    getPipelineManifest: jest.fn(),
    fetchLambdaLogs: jest.fn(),
    lambdaLogSources: jest.fn(() => [{ id: 'lambda:x' }]),
    sfnLogSource: jest.fn(() => ({ id: 'sfn' })),
}));

const {
    resolvePipeline,
    generateRunId,
    startPipelineRun,
    describePipelineRun,
    listPipelineRuns,
    stopPipelineRun,
    getExecutionHistory,
    waitForExecution,
    fetchExecutionLogs,
    followExecutionLogs,
    getPipelineManifest,
    fetchLambdaLogs,
    lambdaLogSources,
} = await import('#src/lib/cli/pipeline.js');
const { PipelineError } = await import('#src/lib/cli/pipeline-utils.js');
const { confirm, isInteractive } = await import('#src/lib/cli/prompt.js');
const { spawnSync } = await import('child_process');
const { getCallerAccount, getBootstrapVersion } =
    await import('#src/lib/cli/aws.js');
const { readLocalConfig } = await import('#src/lib/local-config.js');
const {
    PipelineRunCommand,
    PipelineStatusCommand,
    PipelineDeployCommand,
    PipelineDiffCommand,
    PipelineSynthCommand,
    PipelineWaitCommand,
    PipelineRunsCommand,
    PipelineStopCommand,
    PipelineHistoryCommand,
    PipelineLogsCommand,
} = await import('#src/classes/pipeline.js');

let logSpy;
let errSpy;
const stdout = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
const stderr = () => errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

function writeTempPipelineConfig({
    environment,
    workloadName,
    account = 'controlled',
    region = 'us-east-1',
    cdkJson,
}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-pipeline-deploy-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(
        path.join(dir, 'config', 'default.json'),
        JSON.stringify({
            iac: { environment, workloadName, account, region },
        }),
    );
    if (cdkJson) {
        fs.writeFileSync(path.join(dir, 'cdk.json'), JSON.stringify(cdkJson));
    }
    return dir;
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

describe('PipelineRunCommand', () => {
    test('resolves the state machine ARN and starts an execution with a generated runId', async () => {
        const cmd = new PipelineRunCommand({
            name: 'dev-bedrock-docs',
            region: 'us-east-1',
        });
        await cmd.execute();

        expect(resolvePipeline).toHaveBeenCalledWith(
            'dev-bedrock-docs',
            'us-east-1',
        );
        expect(generateRunId).toHaveBeenCalled();
        expect(startPipelineRun).toHaveBeenCalledWith(
            SM_ARN,
            'run-20261004120000-abc123',
            'us-east-1',
        );
    });

    test('reuses a caller-supplied --run-id instead of generating one', async () => {
        const cmd = new PipelineRunCommand({
            name: 'dev-bedrock-docs',
            region: 'us-east-1',
            runId: 'poc-001',
        });
        await cmd.execute();

        expect(generateRunId).not.toHaveBeenCalled();
        expect(startPipelineRun).toHaveBeenCalledWith(
            'arn:aws:states:us-east-1:123456789012:stateMachine:dev-bedrock-docs-pipeline',
            'poc-001',
            'us-east-1',
        );
    });

    test('action queue runs the version check before starting the execution', () => {
        const cmd = new PipelineRunCommand({ name: 'dev-bedrock-docs' });
        const names = cmd.cmdQueue.map((f) => f.name);
        expect(names).toEqual(['executeVersionCheck', 'executeRun']);
    });

    test('propagates a registry lookup failure instead of swallowing it', async () => {
        resolvePipeline.mockRejectedValueOnce(
            new Error('No pipeline named "missing" found'),
        );
        const cmd = new PipelineRunCommand({ name: 'missing' });
        await expect(cmd.execute()).rejects.toThrow(
            'No pipeline named "missing" found',
        );
    });
});

describe('PipelineStatusCommand', () => {
    test('resolves the state machine ARN and describes the run', async () => {
        const cmd = new PipelineStatusCommand({
            name: 'dev-bedrock-docs',
            runId: 'run-20261004120000-abc123',
            region: 'us-east-1',
        });
        await cmd.execute();

        expect(resolvePipeline).toHaveBeenCalledWith(
            'dev-bedrock-docs',
            'us-east-1',
        );
        expect(describePipelineRun).toHaveBeenCalledWith(
            'arn:aws:states:us-east-1:123456789012:stateMachine:dev-bedrock-docs-pipeline',
            'run-20261004120000-abc123',
            'us-east-1',
        );
    });

    test('propagates an unknown-execution failure instead of swallowing it', async () => {
        describePipelineRun.mockRejectedValueOnce(
            new Error('No execution found for run "bogus"'),
        );
        const cmd = new PipelineStatusCommand({
            name: 'dev-bedrock-docs',
            runId: 'bogus',
        });
        await expect(cmd.execute()).rejects.toThrow(
            'No execution found for run "bogus"',
        );
    });
});

describe.each([
    ['deploy', PipelineDeployCommand],
    ['diff', PipelineDiffCommand],
    ['synth', PipelineSynthCommand],
])('cdk wrapper guards: %s', (verb, Cmd) => {
    let originalCwd;
    let tempDir;
    const enter = (opts = {}) => {
        tempDir = writeTempPipelineConfig({
            environment: 'dev',
            workloadName: 'bedrock-docs',
            ...opts,
        });
        originalCwd = process.cwd();
        process.chdir(tempDir);
        return process.cwd();
    };
    const run = (options = {}) =>
        new Cmd({ name: 'dev-bedrock-docs', ...options }).execute();

    afterEach(() => {
        if (originalCwd) process.chdir(originalCwd);
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        originalCwd = undefined;
        tempDir = undefined;
    });

    test('spawns "npx cdk <verb>" with stdio inherited and no bearer token', async () => {
        const cwd = enter();
        process.env.AWS_BEARER_TOKEN_BEDROCK = 'secret';
        try {
            await expect(run()).resolves.toBeUndefined();
        } finally {
            delete process.env.AWS_BEARER_TOKEN_BEDROCK;
        }

        expect(spawnSync).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = spawnSync.mock.calls[0];
        expect([cmd, args]).toEqual(['npx', ['cdk', verb]]);
        expect(opts.cwd).toBe(cwd);
        expect(opts.stdio).toBe('inherit');
        expect(opts.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
        expect(resolvePipeline).not.toHaveBeenCalled();
        expect(stderr()).toContain('[aws] account 123456789012 (controlled)');
    });

    test('exits 2 when <name> does not match ./config/default.json', async () => {
        enter();
        await expect(
            run({ name: 'prod-other-pipeline' }),
        ).rejects.toMatchObject({
            exitCode: 2,
            message: /doesn't match this directory's pipeline/,
        });
        expect(spawnSync).not.toHaveBeenCalled();
        expect(getCallerAccount).not.toHaveBeenCalled();
    });

    test('exits 2 outside a pipeline repo (no ./config/default.json)', async () => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ari-pipeline-deploy-empty-'),
        );
        originalCwd = process.cwd();
        process.chdir(tempDir);
        await expect(run()).rejects.toMatchObject({
            exitCode: 2,
            message: /Could not read/,
        });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('exits 2 and does not spawn cdk on an account mismatch', async () => {
        enter();
        getCallerAccount.mockResolvedValueOnce('999999999999');
        await expect(run()).rejects.toMatchObject({
            exitCode: 2,
            message: /belongs to the "controlled" account/,
        });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('fails closed (exit 2) when ~/.ari/config.json has no id for the account', async () => {
        enter();
        readLocalConfig.mockReturnValueOnce({ accounts: {} });
        await expect(run()).rejects.toMatchObject({
            exitCode: 2,
            message: /Run: ari init/,
        });
        expect(getCallerAccount).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('exits 2 when iac.account / iac.region is missing', async () => {
        enter({ account: null });
        await expect(run()).rejects.toMatchObject({ exitCode: 2 });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('exits 2 when AWS_REGION disagrees with iac.region', async () => {
        enter();
        process.env.AWS_REGION = 'eu-west-1';
        try {
            await expect(run()).rejects.toMatchObject({
                exitCode: 2,
                message: /AWS_REGION/,
            });
        } finally {
            delete process.env.AWS_REGION;
        }
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('propagates a non-zero cdk exit code as exit 1', async () => {
        enter();
        spawnSync.mockReturnValueOnce({ status: 1, error: null });
        await expect(run()).rejects.toMatchObject({
            exitCode: 1,
            message: `"npx cdk ${verb}" exited with code 1`,
        });
    });
});

describe('bootstrap check and deploy options', () => {
    let originalCwd;
    let tempDir;
    const enter = (opts = {}) => {
        tempDir = writeTempPipelineConfig({
            environment: 'dev',
            workloadName: 'bedrock-docs',
            ...opts,
        });
        originalCwd = process.cwd();
        process.chdir(tempDir);
    };
    const deploy = (options = {}) =>
        new PipelineDeployCommand({
            name: 'dev-bedrock-docs',
            ...options,
        }).execute();
    const spawned = () => spawnSync.mock.calls.map((c) => c[1]);

    afterEach(() => {
        if (originalCwd) process.chdir(originalCwd);
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        originalCwd = undefined;
        tempDir = undefined;
    });

    test('missing bootstrap parameter -> exit 2 with both remedies, cdk not spawned', async () => {
        enter();
        getBootstrapVersion.mockResolvedValueOnce(null);
        await expect(deploy()).rejects.toMatchObject({
            exitCode: 2,
            message: expect.stringMatching(
                /ari pipeline deploy dev-bedrock-docs --bootstrap.*npx cdk bootstrap aws:\/\/123456789012\/us-east-1/,
            ),
        });
        expect(getBootstrapVersion).toHaveBeenCalledWith(
            'hnb659fds',
            'us-east-1',
        );
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('reads the qualifier from cdk.json context', async () => {
        enter({
            cdkJson: {
                context: { '@aws-cdk/core:bootstrapQualifier': 'custom1' },
            },
        });
        await deploy();
        expect(getBootstrapVersion).toHaveBeenCalledWith(
            'custom1',
            'us-east-1',
        );
    });

    test('rejects a malformed qualifier (exit 2)', async () => {
        enter({
            cdkJson: {
                context: { '@aws-cdk/core:bootstrapQualifier': '../x' },
            },
        });
        await expect(deploy()).rejects.toMatchObject({ exitCode: 2 });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('--bootstrap confirms, then spawns bootstrap before deploy', async () => {
        enter();
        await deploy({ bootstrap: true });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(spawned()).toEqual([
            ['cdk', 'bootstrap', 'aws://123456789012/us-east-1'],
            ['cdk', 'deploy'],
        ]);
    });

    test('--bootstrap declined -> exit 2, nothing spawned', async () => {
        enter();
        confirm.mockResolvedValueOnce(false);
        await expect(deploy({ bootstrap: true })).rejects.toMatchObject({
            exitCode: 2,
        });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('--bootstrap off a TTY needs --yes', async () => {
        enter();
        isInteractive.mockReturnValueOnce(false);
        await expect(deploy({ bootstrap: true })).rejects.toMatchObject({
            exitCode: 2,
            message: /--yes/,
        });
        expect(spawnSync).not.toHaveBeenCalled();

        isInteractive.mockReturnValue(false);
        await deploy({ bootstrap: true, yes: true });
        isInteractive.mockReturnValue(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(spawned()[0][1]).toBe('bootstrap');
    });

    test('--require-approval passes through to cdk', async () => {
        enter();
        await deploy({ requireApproval: 'any-change' });
        expect(spawned()).toEqual([
            ['cdk', 'deploy', '--require-approval', 'any-change'],
        ]);
    });

    test('--require-approval never warns, and off a TTY needs --yes', async () => {
        enter();
        isInteractive.mockReturnValue(false);
        await expect(
            deploy({ requireApproval: 'never' }),
        ).rejects.toMatchObject({ exitCode: 2, message: /--yes/ });
        expect(spawnSync).not.toHaveBeenCalled();

        await deploy({ requireApproval: 'never', yes: true });
        isInteractive.mockReturnValue(true);
        expect(stderr()).toContain('NOT be confirmed');
        expect(spawned()).toEqual([
            ['cdk', 'deploy', '--require-approval', 'never'],
        ]);
    });

    test('an unknown --require-approval value is rejected', async () => {
        enter();
        await expect(
            deploy({ requireApproval: 'whatever' }),
        ).rejects.toMatchObject({ exitCode: 2 });
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('diff checks bootstrap; synth does not and passes --quiet', async () => {
        enter();
        getBootstrapVersion.mockResolvedValueOnce(null);
        await expect(
            new PipelineDiffCommand({ name: 'dev-bedrock-docs' }).execute(),
        ).rejects.toMatchObject({ exitCode: 2 });

        getBootstrapVersion.mockClear();
        await new PipelineSynthCommand({
            name: 'dev-bedrock-docs',
            quiet: true,
        }).execute();
        expect(getBootstrapVersion).not.toHaveBeenCalled();
        expect(spawned()).toEqual([['cdk', 'synth', '--quiet']]);
    });
});

function setup(CommandClass, options) {
    return new CommandClass({
        name: 'dev-bedrock-docs',
        region: 'us-east-1',
        ...options,
    });
}

const waitResult = (over = {}) => ({
    outcome: 'done',
    exitCode: 0,
    status: 'SUCCEEDED',
    execution: {
        status: 'SUCCEEDED',
        startDate: new Date('2026-10-04T12:00:00.000Z'),
        stopDate: new Date('2026-10-04T12:19:30.000Z'),
    },
    ...over,
});

describe('PipelineRunCommand --wait', () => {
    test('prints runId + ARN BEFORE waiting, then reflects the result in exitCode', async () => {
        waitResult();
        waitForExecution.mockImplementationOnce(async () => {
            // Ctrl-C safety: the resume info must already be on screen.
            expect(stdout()).toContain('run-20261004120000-abc123');
            expect(stdout()).toContain(EXEC_ARN);
            return waitResult({
                outcome: 'done',
                exitCode: 10,
                status: 'FAILED',
            });
        });
        const cmd = setup(PipelineRunCommand, {
            wait: true,
            interval: '2',
            timeout: '15m',
        });
        await cmd.execute();

        expect(waitForExecution).toHaveBeenCalledWith(
            EXEC_ARN,
            expect.objectContaining({ intervalSec: 2, timeoutSec: 900 }),
            'us-east-1',
        );
        expect(cmd.exitCode).toBe(10);
        expect(stdout()).toContain(
            'ari pipeline history dev-bedrock-docs run-20261004120000-abc123',
        );
        expect(stdout()).toContain(
            'ari pipeline logs dev-bedrock-docs run-20261004120000-abc123',
        );
    });

    test('without --wait it does not poll and still points at status', async () => {
        const cmd = setup(PipelineRunCommand, {});
        await cmd.execute();
        expect(waitForExecution).not.toHaveBeenCalled();
        expect(stdout()).toContain('ari pipeline status dev-bedrock-docs');
        expect(cmd.exitCode).toBe(0);
    });

    test('a bad --timeout is a usage error (exit 2) raised BEFORE the run starts', async () => {
        const cmd = setup(PipelineRunCommand, { wait: true, timeout: 'soon' });
        await expect(cmd.execute()).rejects.toMatchObject({ exitCode: 2 });
        expect(startPipelineRun).not.toHaveBeenCalled();
    });

    test('--interval below 2 is a usage error', async () => {
        const cmd = setup(PipelineRunCommand, { wait: true, interval: '1' });
        await expect(cmd.execute()).rejects.toMatchObject({ exitCode: 2 });
        expect(startPipelineRun).not.toHaveBeenCalled();
    });

    test('--json: prose goes to stderr, stdout is one final JSON object', async () => {
        waitForExecution.mockResolvedValueOnce(waitResult());
        const cmd = setup(PipelineRunCommand, {
            wait: true,
            json: true,
            runId: 'r1',
        });
        await cmd.execute();
        const lines = logSpy.mock.calls.map((c) => c.join(' '));
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toEqual({
            runId: 'r1',
            status: 'SUCCEEDED',
            startDate: '2026-10-04T12:00:00.000Z',
            stopDate: '2026-10-04T12:19:30.000Z',
            durationSec: 1170,
        });
        expect(stderr()).toContain('Started');
    });

    test('timeout / interrupt / expiry outcomes set 3 / 130 / 4 and say the run is unaffected', async () => {
        const cases = [
            [
                { outcome: 'timeout', exitCode: 3, status: 'RUNNING' },
                3,
                /still RUNNING/,
            ],
            [
                { outcome: 'interrupted', exitCode: 130, status: 'RUNNING' },
                130,
                /Stopped waiting\. Run .* is still RUNNING[\s\S]*ari pipeline wait[\s\S]*ari pipeline stop/,
            ],
            [
                { outcome: 'expired', exitCode: 4, status: 'RUNNING' },
                4,
                /Credentials expired;[\s\S]*unaffected \(still RUNNING\)[\s\S]*ari pipeline wait/,
            ],
        ];
        for (const [result, code, message] of cases) {
            errSpy.mockClear();
            waitForExecution.mockResolvedValueOnce(waitResult(result));
            const cmd = setup(PipelineRunCommand, { wait: true, runId: 'r1' });
            await cmd.execute();
            expect(cmd.exitCode).toBe(code);
            expect(stderr()).toMatch(message);
        }
        expect(stopPipelineRun).not.toHaveBeenCalled();
    });
});

describe('PipelineWaitCommand', () => {
    test('describes the run (friendly missing-run error) then waits on its ARN', async () => {
        waitForExecution.mockResolvedValueOnce(
            waitResult({ exitCode: 12, status: 'ABORTED' }),
        );
        const cmd = setup(PipelineWaitCommand, { runId: 'r1' });
        await cmd.execute();
        expect(describePipelineRun).toHaveBeenCalledWith(
            SM_ARN,
            'r1',
            'us-east-1',
        );
        expect(waitForExecution).toHaveBeenCalledWith(
            EXEC_ARN,
            expect.any(Object),
            'us-east-1',
        );
        expect(cmd.exitCode).toBe(12);
    });

    test('propagates a missing run before waiting', async () => {
        describePipelineRun.mockRejectedValueOnce(
            new Error('No execution found for run "x"'),
        );
        const cmd = setup(PipelineWaitCommand, { runId: 'x' });
        await expect(cmd.execute()).rejects.toThrow('No execution found');
        expect(waitForExecution).not.toHaveBeenCalled();
    });
});

describe('PipelineStatusCommand output handling', () => {
    const finished = {
        status: 'SUCCEEDED',
        startDate: new Date('2026-10-04T12:00:00.000Z'),
        stopDate: new Date('2026-10-04T12:05:00.000Z'),
        output: '{"secret":"SENTINEL_PROTECTED_TEXT"}',
    };

    test('hides the execution output by default', async () => {
        describePipelineRun.mockResolvedValueOnce(finished);
        await setup(PipelineStatusCommand, { runId: 'r1' }).execute();
        expect(stdout()).not.toContain('SENTINEL_PROTECTED_TEXT');
        expect(stdout()).toContain('--show-output');
    });

    test('--show-output prints it behind a protected-data banner naming the caller', async () => {
        describePipelineRun.mockResolvedValueOnce(finished);
        await setup(PipelineStatusCommand, {
            runId: 'r1',
            showOutput: true,
        }).execute();
        expect(stdout()).toContain('SENTINEL_PROTECTED_TEXT');
        expect(stderr()).toContain('PROTECTED DATA');
        expect(stderr()).toContain('assumed-role/Admin/jo');
    });
});

describe('PipelineRunsCommand', () => {
    const runs = [
        {
            runId: 'controlled-run-2',
            status: 'SUCCEEDED',
            startDate: new Date('2026-10-14T09:02:00'),
            stopDate: new Date('2026-10-14T09:21:30'),
        },
        {
            runId: 'dev-run-1',
            status: 'ABORTED',
            startDate: new Date('2026-10-13T11:15:00'),
            stopDate: new Date('2026-10-13T11:16:50'),
        },
    ];

    test('prints a table with duration and passes filters through', async () => {
        listPipelineRuns.mockResolvedValueOnce({ runs, truncated: false });
        await setup(PipelineRunsCommand, {
            status: 'ABORTED',
            limit: '5',
        }).execute();
        expect(listPipelineRuns).toHaveBeenCalledWith(
            SM_ARN,
            { status: 'ABORTED', limit: 5, all: undefined },
            'us-east-1',
        );
        const out = stdout();
        expect(out).toMatch(/RUN ID\s+STATUS\s+STARTED\s+DURATION/);
        expect(out).toMatch(
            /controlled-run-2\s+SUCCEEDED\s+2026-10-14 09:02\s+19m 30s/,
        );
        expect(out).toContain('2 runs');
    });

    test('--json emits an array with ISO dates', async () => {
        listPipelineRuns.mockResolvedValueOnce({ runs, truncated: false });
        await setup(PipelineRunsCommand, { json: true }).execute();
        const parsed = JSON.parse(logSpy.mock.calls[0][0]);
        expect(parsed[0]).toMatchObject({
            runId: 'controlled-run-2',
            status: 'SUCCEEDED',
            durationSec: 1170,
        });
        expect(parsed[0].startDate).toMatch(/^\d{4}-\d\d-\d\dT/);
    });

    test('rejects bad --limit / --status with exit 2', async () => {
        await expect(
            setup(PipelineRunsCommand, { limit: '0' }).execute(),
        ).rejects.toMatchObject({ exitCode: 2 });
        await expect(
            setup(PipelineRunsCommand, { status: 'DONE' }).execute(),
        ).rejects.toMatchObject({ exitCode: 2 });
        expect(listPipelineRuns).not.toHaveBeenCalled();
    });
});

describe('PipelineStopCommand', () => {
    test('refuses a run that is not RUNNING (exit 1) and never calls StopExecution', async () => {
        describePipelineRun.mockResolvedValueOnce({ status: 'SUCCEEDED' });
        const cmd = setup(PipelineStopCommand, { runId: 'r1', yes: true });
        await expect(cmd.execute()).rejects.toThrow(/SUCCEEDED, not RUNNING/);
        expect(stopPipelineRun).not.toHaveBeenCalled();
    });

    test('on a TTY asks for confirmation; yes stops with the default cause naming the caller', async () => {
        await setup(PipelineStopCommand, { runId: 'r1' }).execute();
        expect(confirm).toHaveBeenCalled();
        expect(stopPipelineRun).toHaveBeenCalledWith(
            SM_ARN,
            'r1',
            'Stopped via ari-cli by arn:aws:sts::123456789012:assumed-role/Admin/jo',
            'us-east-1',
        );
        expect(stdout()).toMatch(/NOT cancelled/);
        expect(stdout()).toMatch(/cannot be reused/);
    });

    test('declining the prompt does not stop (exit 2)', async () => {
        confirm.mockResolvedValueOnce(false);
        const cmd = setup(PipelineStopCommand, { runId: 'r1' });
        await expect(cmd.execute()).rejects.toMatchObject({ exitCode: 2 });
        expect(stopPipelineRun).not.toHaveBeenCalled();
    });

    test('non-TTY without --yes is refused with exit 2 (no prompt)', async () => {
        isInteractive.mockReturnValueOnce(false);
        const cmd = setup(PipelineStopCommand, { runId: 'r1' });
        await expect(cmd.execute()).rejects.toMatchObject({ exitCode: 2 });
        expect(confirm).not.toHaveBeenCalled();
        expect(stopPipelineRun).not.toHaveBeenCalled();
    });

    test('--yes skips the prompt even off a TTY, and --cause is passed through', async () => {
        isInteractive.mockReturnValueOnce(false);
        await setup(PipelineStopCommand, {
            runId: 'r1',
            yes: true,
            cause: 'bad data',
        }).execute();
        expect(confirm).not.toHaveBeenCalled();
        expect(stopPipelineRun).toHaveBeenCalledWith(
            SM_ARN,
            'r1',
            'bad data',
            'us-east-1',
        );
    });
});

describe('PipelineHistoryCommand', () => {
    const t = (s) => new Date(Date.UTC(2026, 9, 14, 9, 0, s));
    const events = [
        {
            id: 1,
            previousEventId: 0,
            type: 'TaskStateEntered',
            timestamp: t(0),
            stateEnteredEventDetails: {
                name: 'extract-text',
                input: 'SENTINEL_PROTECTED_TEXT',
            },
        },
        { id: 2, previousEventId: 1, type: 'TaskScheduled', timestamp: t(0) },
        {
            id: 3,
            previousEventId: 2,
            type: 'TaskFailed',
            timestamp: t(5),
            taskFailedEventDetails: {
                error: 'INVALID_JSON_FROM_MODEL',
                cause: 'SENTINEL_PROTECTED_TEXT',
            },
        },
        {
            id: 4,
            previousEventId: 3,
            type: 'ExecutionFailed',
            timestamp: t(6),
            executionFailedEventDetails: {
                error: 'INVALID_JSON_FROM_MODEL',
                cause: 'SENTINEL_PROTECTED_TEXT',
            },
        },
    ];

    test('prints state rows with the error code and never any payload text', async () => {
        getExecutionHistory.mockResolvedValueOnce(events);
        await setup(PipelineHistoryCommand, { runId: 'r1' }).execute();
        const out = stdout();
        expect(out).toMatch(
            /STATE\s+TYPE\s+ENTERED\s+DURATION\s+ATTEMPTS\s+RESULT/,
        );
        expect(out).toMatch(
            /extract-text\s+Task.*FAILED error=INVALID_JSON_FROM_MODEL/,
        );
        expect(out).toMatch(
            /Execution: .*FAILED error=INVALID_JSON_FROM_MODEL/,
        );
        expect(out + stderr()).not.toContain('SENTINEL_PROTECTED_TEXT');
    });

    test('--json emits the folded structure, not raw events, with no payloads', async () => {
        getExecutionHistory.mockResolvedValueOnce(events);
        await setup(PipelineHistoryCommand, {
            runId: 'r1',
            json: true,
        }).execute();
        const raw = logSpy.mock.calls[0][0];
        expect(raw).not.toContain('SENTINEL_PROTECTED_TEXT');
        const parsed = JSON.parse(raw);
        expect(parsed.states[0]).toMatchObject({
            name: 'extract-text',
            result: 'FAILED',
            error: 'INVALID_JSON_FROM_MODEL',
        });
        expect(parsed.states[0]).not.toHaveProperty('stateEnteredEventDetails');
    });

    test('--show-cause prints the cause (truncated) behind a banner', async () => {
        getExecutionHistory.mockResolvedValueOnce(events);
        await setup(PipelineHistoryCommand, {
            runId: 'r1',
            showCause: true,
        }).execute();
        expect(stderr()).toContain('PROTECTED DATA');
        expect(stdout()).toContain('cause: SENTINEL_PROTECTED_TEXT');
    });

    test('--failed-only drops healthy states', async () => {
        const ok = [
            {
                id: 10,
                previousEventId: 0,
                type: 'TaskStateEntered',
                timestamp: t(0),
                stateEnteredEventDetails: { name: 'healthy' },
            },
            {
                id: 11,
                previousEventId: 10,
                type: 'TaskStateExited',
                timestamp: t(1),
                stateExitedEventDetails: { name: 'healthy' },
            },
        ];
        getExecutionHistory.mockResolvedValueOnce([
            ...ok,
            ...events.map((e) => ({
                ...e,
                id: e.id + 20,
                previousEventId: e.previousEventId
                    ? e.previousEventId + 20
                    : 11,
            })),
        ]);
        await setup(PipelineHistoryCommand, {
            runId: 'r1',
            failedOnly: true,
        }).execute();
        expect(stdout()).not.toContain('healthy');
        expect(stdout()).toContain('extract-text');
    });
});

describe('PipelineLogsCommand', () => {
    const ev = (message) => ({
        eventId: 'e1',
        timestamp: Date.UTC(2026, 9, 14, 9, 0, 0),
        message,
    });

    test('renders allow-listed lines only, never payload fields', async () => {
        fetchExecutionLogs.mockResolvedValueOnce({
            events: [
                ev(
                    JSON.stringify({
                        type: 'TaskFailed',
                        details: {
                            name: 'parse-file',
                            error: 'E1',
                            cause: 'SENTINEL_PROTECTED_TEXT',
                            input: 'SENTINEL_PROTECTED_TEXT',
                        },
                    }),
                ),
            ],
            truncated: false,
        });
        await setup(PipelineLogsCommand, { runId: 'r1' }).execute();
        expect(stdout()).toContain('TaskFailed parse-file error=E1');
        expect(stdout() + stderr()).not.toContain('SENTINEL_PROTECTED_TEXT');
        expect(fetchExecutionLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                executionArn: EXEC_ARN,
                limit: 200,
                logGroupName: '/aws/vendedlogs/states/x',
            }),
            'us-east-1',
        );
    });

    describe('--source lambda / all', () => {
        const GROUPS = [
            '/aws/lambda/dev-bedrock-docs-file-step-runner',
            '/aws/lambda/dev-bedrock-docs-run-step-runner',
        ];
        const lambdaEvent = (line, ts = Date.UTC(2026, 9, 14, 9, 0, 1)) => ({
            timestamp: ts,
            eventId: `l-${ts}`,
            source: 'lambda:file-step-runner',
            line,
        });

        beforeEach(() => {
            getPipelineManifest.mockResolvedValue({
                schema: 1,
                logGroups: { lambda: GROUPS },
            });
        });

        test('reads the manifest, fetches the manifest log groups for this run, and prints the interleave notice once', async () => {
            fetchLambdaLogs.mockResolvedValueOnce({
                events: [
                    lambdaEvent(
                        '09:00:01 lambda:file-step-runner REPORT duration=12ms',
                    ),
                ],
                truncated: false,
            });
            await setup(PipelineLogsCommand, {
                runId: 'r1',
                source: 'lambda',
            }).execute();

            expect(getPipelineManifest).toHaveBeenCalledWith(
                'dev-bedrock-docs',
                'us-east-1',
            );
            expect(fetchLambdaLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    logGroupNames: GROUPS,
                    runId: 'r1',
                    limit: 200,
                }),
                'us-east-1',
            );
            expect(fetchExecutionLogs).not.toHaveBeenCalled();
            expect(stdout()).toContain(
                'lambda:file-step-runner REPORT duration=12ms',
            );
            expect(stderr().match(/concurrent runs/g)).toHaveLength(1);
            expect(stderr()).toContain('request id, not a run id');
        });

        test("passes the finished execution's stop time (plus grace) as the window end", async () => {
            describePipelineRun.mockResolvedValueOnce({
                status: 'SUCCEEDED',
                executionArn: EXEC_ARN,
                startDate: new Date('2026-10-04T12:00:00.000Z'),
                stopDate: new Date('2026-10-04T12:05:00.000Z'),
            });
            fetchLambdaLogs.mockResolvedValueOnce({
                events: [],
                truncated: false,
            });
            await setup(PipelineLogsCommand, {
                runId: 'r1',
                source: 'lambda',
            }).execute();
            const args = fetchLambdaLogs.mock.calls[0][0];
            expect(args.startTime).toBe(Date.parse('2026-10-04T12:00:00.000Z'));
            expect(args.endTime).toBe(Date.parse('2026-10-04T12:05:10.000Z'));
        });

        test('a missing manifest is a clear error and nothing is fetched', async () => {
            getPipelineManifest.mockRejectedValueOnce(
                new PipelineError(
                    '"dev-bedrock-docs" has no manifest ... redeploy',
                ),
            );
            await expect(
                setup(PipelineLogsCommand, {
                    runId: 'r1',
                    source: 'lambda',
                }).execute(),
            ).rejects.toThrow(/no manifest/);
            expect(fetchLambdaLogs).not.toHaveBeenCalled();
            expect(fetchExecutionLogs).not.toHaveBeenCalled();
        });

        test('--source sfn never reads the manifest or prints the interleave notice', async () => {
            fetchExecutionLogs.mockResolvedValueOnce({
                events: [],
                truncated: false,
            });
            await setup(PipelineLogsCommand, { runId: 'r1' }).execute();
            expect(getPipelineManifest).not.toHaveBeenCalled();
            expect(stderr()).not.toContain('concurrent runs');
        });

        test('--source all merges sfn and lambda lines in time order', async () => {
            fetchExecutionLogs.mockResolvedValueOnce({
                events: [
                    {
                        eventId: 's1',
                        timestamp: Date.UTC(2026, 9, 14, 9, 0, 0),
                        message: JSON.stringify({
                            type: 'TaskStateEntered',
                            details: { name: 'parse-file' },
                        }),
                    },
                    {
                        eventId: 's2',
                        timestamp: Date.UTC(2026, 9, 14, 9, 0, 5),
                        message: JSON.stringify({
                            type: 'TaskStateExited',
                            details: { name: 'parse-file' },
                        }),
                    },
                ],
                truncated: false,
            });
            fetchLambdaLogs.mockResolvedValueOnce({
                events: [
                    lambdaEvent('LAMBDA-LINE', Date.UTC(2026, 9, 14, 9, 0, 3)),
                ],
                truncated: false,
            });
            await setup(PipelineLogsCommand, {
                runId: 'r1',
                source: 'all',
            }).execute();
            const lines = logSpy.mock.calls.map((c) => c[0]);
            expect(lines).toHaveLength(3);
            expect(lines[0]).toContain('TaskStateEntered parse-file');
            expect(lines[1]).toBe('LAMBDA-LINE');
            expect(lines[2]).toContain('TaskStateExited parse-file');
        });

        test('--json prints {timestamp, line} objects and still only the notice on stderr', async () => {
            fetchLambdaLogs.mockResolvedValueOnce({
                events: [lambdaEvent('LAMBDA-LINE')],
                truncated: false,
            });
            await setup(PipelineLogsCommand, {
                runId: 'r1',
                source: 'lambda',
                json: true,
            }).execute();
            const parsed = JSON.parse(logSpy.mock.calls[0][0]);
            expect(parsed).toEqual({
                timestamp: '2026-10-14T09:00:01.000Z',
                line: 'LAMBDA-LINE',
            });
        });

        test('--follow with lambda hands the follow loop one source per group (plus sfn for all)', async () => {
            followExecutionLogs.mockResolvedValueOnce({
                outcome: 'done',
                exitCode: 0,
                status: 'SUCCEEDED',
            });
            await setup(PipelineLogsCommand, {
                runId: 'r1',
                source: 'all',
                follow: true,
            }).execute();
            expect(lambdaLogSources).toHaveBeenCalledWith(GROUPS, 'r1', {
                full: undefined,
            });
            const [args] = followExecutionLogs.mock.calls[0];
            expect(args.sources.map((x) => x.id)).toEqual(['sfn', 'lambda:x']);
        });
    });

    test('--follow uses the follow loop and propagates its exit code', async () => {
        followExecutionLogs.mockResolvedValueOnce({
            outcome: 'interrupted',
            exitCode: 130,
            status: 'RUNNING',
        });
        const cmd = setup(PipelineLogsCommand, { runId: 'r1', follow: true });
        await cmd.execute();
        expect(followExecutionLogs).toHaveBeenCalled();
        expect(cmd.exitCode).toBe(130);
        expect(fetchExecutionLogs).not.toHaveBeenCalled();
    });

    test('--since is parsed into the window start', async () => {
        fetchExecutionLogs.mockResolvedValueOnce({
            events: [],
            truncated: false,
        });
        const before = Date.now();
        await setup(PipelineLogsCommand, {
            runId: 'r1',
            since: '15m',
        }).execute();
        const { startTime } = fetchExecutionLogs.mock.calls[0][0];
        expect(startTime).toBeGreaterThanOrEqual(before - 15 * 60 * 1000);
        expect(startTime).toBeLessThanOrEqual(
            Date.now() - 15 * 60 * 1000 + 1000,
        );
    });
});
