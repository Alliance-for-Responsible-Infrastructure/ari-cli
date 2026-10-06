import crypto from 'crypto';

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
    SFNClient,
    StartExecutionCommand,
    DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';

export const DEFAULT_PIPELINE_REGION = 'us-east-1';

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
) {
    const ssm = new SSMClient({ region });
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
) {
    const sfn = new SFNClient({ region });
    const { executionArn, startDate } = await sfn.send(
        new StartExecutionCommand({
            stateMachineArn,
            name: runId,
            input: JSON.stringify({ runId }),
        }),
    );
    return { executionArn, startDate };
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
) {
    const sfn = new SFNClient({ region });
    const executionArn = executionArnFor(stateMachineArn, runId);
    try {
        return await sfn.send(
            new DescribeExecutionCommand({ executionArn }),
        );
    } catch (e) {
        if (e.name === 'ExecutionDoesNotExist') {
            throw new Error(
                `No execution found for run "${runId}" on this pipeline. Check the runId, or that "ari pipeline run" actually started it.`,
            );
        }
        throw e;
    }
}
