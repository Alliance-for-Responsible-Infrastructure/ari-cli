import { styles } from '#src/lib/cli/terminal.js';
import {
    PipelineRunCommand,
    PipelineStatusCommand,
    PipelineDeployCommand,
} from '#src/classes/pipeline.js';

const { error } = styles;

async function runCommand(CommandClass, options) {
    const cmd = new CommandClass(options);
    try {
        await cmd.execute();
    } catch (e) {
        console.error(error('Error:'), e.message);
        process.exit(1);
    }
    process.exit(0);
}

/**
 * `ari pipeline deploy <name>` — see PipelineDeployCommand. Must be run from
 * inside the named pipeline's own repo directory.
 * @param {Object} options
 * @param {string} options.name
 */
export const deploy = (options) => runCommand(PipelineDeployCommand, options);

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
