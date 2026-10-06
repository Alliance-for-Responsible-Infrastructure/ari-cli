/**
 * Tests for PipelineRunCommand / PipelineStatusCommand / PipelineDeployCommand
 * — command sequencing and output for `ari pipeline run|status|deploy`. All
 * AWS calls are mocked at the src/lib/cli/pipeline.js layer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, expect, test, afterEach } from '@jest/globals';

jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('child_process', () => ({
    spawnSync: jest.fn(() => ({ status: 0, error: null })),
}));

jest.unstable_mockModule('#src/lib/cli/pipeline.js', () => ({
    resolveStateMachineArn: jest
        .fn()
        .mockResolvedValue(
            'arn:aws:states:us-east-1:123456789012:stateMachine:dev-bedrock-docs-pipeline',
        ),
    generateRunId: jest.fn(() => 'run-20261004120000-abc123'),
    startPipelineRun: jest.fn().mockResolvedValue({
        executionArn:
            'arn:aws:states:us-east-1:123456789012:execution:dev-bedrock-docs-pipeline:run-20261004120000-abc123',
        startDate: new Date('2026-10-04T12:00:00.000Z'),
    }),
    describePipelineRun: jest.fn().mockResolvedValue({
        status: 'RUNNING',
        startDate: new Date('2026-10-04T12:00:00.000Z'),
    }),
}));

const {
    resolveStateMachineArn,
    generateRunId,
    startPipelineRun,
    describePipelineRun,
} = await import('#src/lib/cli/pipeline.js');
const { spawnSync } = await import('child_process');
const {
    PipelineRunCommand,
    PipelineStatusCommand,
    PipelineDeployCommand,
} = await import('#src/classes/pipeline.js');

function writeTempPipelineConfig({ environment, workloadName }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-pipeline-deploy-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(
        path.join(dir, 'config', 'default.json'),
        JSON.stringify({ iac: { environment, workloadName } }),
    );
    return dir;
}

afterEach(() => {
    jest.clearAllMocks();
});

describe('PipelineRunCommand', () => {
    test('resolves the state machine ARN and starts an execution with a generated runId', async () => {
        const cmd = new PipelineRunCommand({
            name: 'dev-bedrock-docs',
            region: 'us-east-1',
        });
        await cmd.execute();

        expect(resolveStateMachineArn).toHaveBeenCalledWith(
            'dev-bedrock-docs',
            'us-east-1',
        );
        expect(generateRunId).toHaveBeenCalled();
        expect(startPipelineRun).toHaveBeenCalledWith(
            'arn:aws:states:us-east-1:123456789012:stateMachine:dev-bedrock-docs-pipeline',
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
        resolveStateMachineArn.mockRejectedValueOnce(
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

        expect(resolveStateMachineArn).toHaveBeenCalledWith(
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

describe('PipelineDeployCommand', () => {
    let originalCwd;
    let tempDir;

    afterEach(() => {
        if (originalCwd) process.chdir(originalCwd);
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        originalCwd = undefined;
        tempDir = undefined;
    });

    test('reads ./config/default.json and shells "npx cdk deploy" with stdio inherited', async () => {
        tempDir = writeTempPipelineConfig({
            environment: 'dev',
            workloadName: 'bedrock-docs',
        });
        originalCwd = process.cwd();
        process.chdir(tempDir);
        const resolvedCwd = process.cwd();

        const cmd = new PipelineDeployCommand({ name: 'dev-bedrock-docs' });
        await expect(cmd.execute()).resolves.toBeUndefined();

        expect(spawnSync).toHaveBeenCalledWith('npx', ['cdk', 'deploy'], {
            cwd: resolvedCwd,
            stdio: 'inherit',
        });
        expect(resolveStateMachineArn).not.toHaveBeenCalled();
        expect(startPipelineRun).not.toHaveBeenCalled();
        expect(describePipelineRun).not.toHaveBeenCalled();
    });

    test('errors loudly instead of deploying when <name> does not match ./config/default.json', async () => {
        tempDir = writeTempPipelineConfig({
            environment: 'dev',
            workloadName: 'bedrock-docs',
        });
        originalCwd = process.cwd();
        process.chdir(tempDir);

        const cmd = new PipelineDeployCommand({ name: 'prod-other-pipeline' });
        await expect(cmd.execute()).rejects.toThrow(
            /doesn't match this directory's pipeline/,
        );
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('errors loudly when run outside a pipeline repo (no ./config/default.json)', async () => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ari-pipeline-deploy-empty-'),
        );
        originalCwd = process.cwd();
        process.chdir(tempDir);

        const cmd = new PipelineDeployCommand({ name: 'dev-bedrock-docs' });
        await expect(cmd.execute()).rejects.toThrow('Could not read');
        expect(spawnSync).not.toHaveBeenCalled();
    });

    test('propagates a non-zero "cdk deploy" exit code as an error', async () => {
        tempDir = writeTempPipelineConfig({
            environment: 'dev',
            workloadName: 'bedrock-docs',
        });
        originalCwd = process.cwd();
        process.chdir(tempDir);
        spawnSync.mockReturnValueOnce({ status: 1, error: null });

        const cmd = new PipelineDeployCommand({ name: 'dev-bedrock-docs' });
        await expect(cmd.execute()).rejects.toThrow(
            '"npx cdk deploy" exited with code 1',
        );
    });
});
