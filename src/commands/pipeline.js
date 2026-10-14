import { styles } from '#src/lib/cli/terminal.js';
import {
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
} from '#src/classes/pipeline.js';
import {
    PipelineDataStagesCommand,
    PipelineDataLsCommand,
    PipelineDataLoadCommand,
    PipelineDataGetCommand,
    PipelineDataInspectCommand,
    PipelineDataCatCommand,
} from '#src/classes/pipeline-data.js';

const { error } = styles;

/**
 * Runs a command class and exits with its exit code: `e.exitCode ?? 1` for
 * errors (PipelineError carries one), `cmd.exitCode ?? 0` on success (e.g.
 * `wait` exits 10 for a FAILED execution without throwing).
 */
export async function runCommand(CommandClass, options) {
    const cmd = new CommandClass(options);
    try {
        await cmd.execute();
    } catch (e) {
        console.error(error('Error:'), e.message);
        process.exit(e.exitCode ?? 1);
    }
    process.exit(cmd.exitCode ?? 0);
}

/**
 * `ari pipeline deploy <name>` — see PipelineDeployCommand. Must be run from
 * inside the named pipeline's own repo directory.
 * @param {Object} options
 * @param {string} options.name
 */
export const deploy = (options) => runCommand(PipelineDeployCommand, options);

/**
 * `ari pipeline diff <name>` — guarded `cdk diff`; same cwd rules as deploy.
 * @param {Object} options
 * @param {string} options.name
 */
export const diff = (options) => runCommand(PipelineDiffCommand, options);

/**
 * `ari pipeline synth <name>` — guarded `cdk synth`; same cwd rules as deploy.
 * @param {Object} options
 * @param {string} options.name
 * @param {boolean} [options.quiet]
 */
export const synth = (options) => runCommand(PipelineSynthCommand, options);

/**
 * `ari pipeline run <name>` — starts an execution of a named pipeline.
 * @param {Object} options
 * @param {string} options.name
 * @param {string} options.region
 * @param {string} [options.runId] - reuse this runId instead of generating a new one
 */
export const run = (options) => runCommand(PipelineRunCommand, options);

/**
 * `ari pipeline status <name> <runId>` — reports a pipeline run's status.
 * @param {Object} options
 * @param {string} options.name
 * @param {string} options.runId
 * @param {string} options.region
 */
export const status = (options) => runCommand(PipelineStatusCommand, options);

/**
 * `ari pipeline wait <name> <runId>` — waits for an existing run to finish.
 * @param {Object} options - name, runId, region, interval, timeout, json
 */
export const wait = (options) => runCommand(PipelineWaitCommand, options);

/**
 * `ari pipeline runs <name>` — lists runs (executions).
 * @param {Object} options - name, region, status, limit, all, json
 */
export const runs = (options) => runCommand(PipelineRunsCommand, options);

/**
 * `ari pipeline stop <name> <runId>` — stops a RUNNING run (confirmed).
 * @param {Object} options - name, runId, region, cause, yes
 */
export const stop = (options) => runCommand(PipelineStopCommand, options);

/**
 * `ari pipeline history <name> <runId>` — per-state summary of a run.
 * @param {Object} options - name, runId, region, failedOnly, showCause, json
 */
export const history = (options) => runCommand(PipelineHistoryCommand, options);

/**
 * `ari pipeline logs <name> <runId>` — Step Functions log events for a run.
 * @param {Object} options - name, runId, region, source, follow, since, limit, full, json
 */
export const logs = (options) => runCommand(PipelineLogsCommand, options);

/**
 * `ari pipeline data stages <name>` -- the manifest's stages (no content).
 * @param {Object} options - name, region, json
 */
export const dataStages = (options) =>
    runCommand(PipelineDataStagesCommand, options);

/**
 * `ari pipeline data ls <name> <runId>` -- keys/sizes/dates (no content).
 * @param {Object} options - name, runId, region, stage, match, ids, json
 */
export const dataLs = (options) => runCommand(PipelineDataLsCommand, options);

/**
 * `ari pipeline data load <name> <localDir> --run-id <id>` -- upload files.
 * @param {Object} options - name, localDir, runId, region, stage, yes
 */
export const dataLoad = (options) =>
    runCommand(PipelineDataLoadCommand, options);

/**
 * `ari pipeline data get <name> <runId> [id]` -- gated download.
 * @param {Object} options - name, runId, id, region, stage, out, force, yes
 */
export const dataGet = (options) => runCommand(PipelineDataGetCommand, options);

/**
 * `ari pipeline fetch <name> <runId>` -- gated download of the result key.
 * @param {Object} options - name, runId, region, out, force, yes
 */
export const fetchResult = (options) =>
    runCommand(PipelineDataGetCommand, { ...options, fetch: true });

/**
 * `ari pipeline data inspect <name> <runId> <id> --stage <s>` -- structure only.
 * @param {Object} options - name, runId, id, region, stage, json
 */
export const dataInspect = (options) =>
    runCommand(PipelineDataInspectCommand, options);

/**
 * `ari pipeline data cat <name> <runId> <id> --stage <s>` -- gated, bounded print.
 * @param {Object} options - name, runId, id, region, stage, maxBytes, head, yes
 */
export const dataCat = (options) => runCommand(PipelineDataCatCommand, options);
