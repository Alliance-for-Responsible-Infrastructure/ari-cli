import * as fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { styles } from '#src/lib/cli/terminal.js';
import {
    resolveStateMachineArn,
    generateRunId,
    startPipelineRun,
    describePipelineRun,
} from '#src/lib/cli/pipeline.js';
import BaseAriCommand from './base-command.js';

const { success, error, warn, emphasis, bold } = styles;

/**
 * `ari pipeline run <name>` — starts an execution of a named pipeline.
 * Resolves <name> to a state machine ARN via the registry SSM parameter
 * (see src/lib/cli/pipeline.js) and starts it with either a caller-supplied
 * runId (--run-id, so data pre-loaded under a known id is visible to this
 * run) or a freshly generated one — no knowledge of what the pipeline
 * actually does.
 */
export class PipelineRunCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.region = options.region;
        this.runId = options.runId;
        this.addActions();
    }

    async executeRun() {
        const stateMachineArn = await resolveStateMachineArn(
            this.name,
            this.region,
        );
        const runId = this.runId ?? generateRunId();
        const { executionArn } = await startPipelineRun(
            stateMachineArn,
            runId,
            this.region,
        );

        console.log(
            success('Started:'),
            `pipeline ${emphasis(this.name)}, run ${emphasis(runId)}`,
        );
        console.log(`Execution: ${executionArn}`);
        console.log(
            'Check status with:',
            emphasis(`ari pipeline status ${this.name} ${runId}`),
        );
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeRun);
    }
}

/**
 * `ari pipeline status <name> <runId>` — reports a pipeline run's status by
 * describing its Step Functions execution directly. No pipeline-specific
 * per-file detail (that would require knowing that pipeline's own
 * DynamoDB schema) — just the execution-level status every pipeline's
 * state machine has in common.
 */
export class PipelineStatusCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.addActions();
    }

    #statusStyle(status) {
        if (status === 'SUCCEEDED') return success;
        if (status === 'RUNNING') return emphasis;
        return error;
    }

    async executeStatus() {
        const stateMachineArn = await resolveStateMachineArn(
            this.name,
            this.region,
        );
        const execution = await describePipelineRun(
            stateMachineArn,
            this.runId,
            this.region,
        );

        const statusStyle = this.#statusStyle(execution.status);
        console.log(
            bold(`Run ${this.runId}`),
            `(${this.name}):`,
            statusStyle(execution.status),
        );
        console.log(`Started: ${new Date(execution.startDate).toLocaleString()}`);
        if (execution.stopDate) {
            console.log(
                `Stopped: ${new Date(execution.stopDate).toLocaleString()}`,
            );
        }
        if (execution.status !== 'RUNNING' && execution.output) {
            console.log('Output:', execution.output);
        }
        if (execution.status === 'FAILED' || execution.status === 'TIMED_OUT') {
            console.log(
                warn('Note:'),
                'this only reflects the execution as a whole — check the',
                "pipeline's own CloudWatch log group or state table for which",
                'file(s) actually failed.',
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeStatus);
    }
}

/**
 * `ari pipeline deploy <name>` — a thin, cwd-based wrapper around `cdk
 * deploy`, not a name -> repo-path registry (that registry problem doesn't
 * need solving yet — see ari-cli/references/pipeline-cli-workflow-steps.md).
 * Must be run from inside the named pipeline's own repo directory, the same
 * place a human would run `npx cdk deploy` by hand. Reads that repo's own
 * `./config/default.json` directly off disk (plain fs.readFileSync, *not*
 * the `config` npm package — that package resolves relative to ari-cli's
 * own install location, not the caller's cwd) to compute
 * `projectName = "{environment}-{workloadName}"` and compares it against
 * the given <name> as a cheap "wrong directory" safety check. Does no AWS
 * SDK work of its own — `npx cdk deploy` runs with stdio inherited so CDK's
 * own interactive diff/approval prompts and output reach the user directly.
 */
export class PipelineDeployCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.addActions();
    }

    #readProjectName() {
        const configPath = path.join(this.cwd, 'config', 'default.json');
        let config;
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
            throw new Error(
                `Could not read ${configPath} (${e.message}) — run "ari pipeline deploy ${this.name}" from inside ${this.name}'s own repo directory.`,
            );
        }

        const { environment, workloadName } = config.iac ?? {};
        return `${environment}-${workloadName}`;
    }

    async executeDeploy() {
        const projectName = this.#readProjectName();
        if (projectName !== this.name) {
            throw new Error(
                `"${this.name}" doesn't match this directory's pipeline ("${projectName}", per ./config/default.json) — run this from inside ${this.name}'s own repo directory instead.`,
            );
        }

        console.log(
            success('Deploying:'),
            `${emphasis(projectName)} via "npx cdk deploy" (output below is CDK's own)`,
        );

        const result = spawnSync('npx', ['cdk', 'deploy'], {
            cwd: this.cwd,
            stdio: 'inherit',
        });

        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`"npx cdk deploy" exited with code ${result.status}`);
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeDeploy);
    }
}
