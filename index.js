#!/usr/bin/env node
import path from 'path';
import * as url from 'url';
import { Command, Option } from 'commander';

import { versionString } from '#src/lib/program-utils.js';
import requireJSON from '#src/lib/require-json.js';
import credentials from '#src/commands/credentials.js';
import init from '#src/commands/init.js';
import * as pipeline from '#src/commands/pipeline.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ariConfig = requireJSON(path.join(__dirname, 'ari-config.json'));
const { accounts, roles, defaultRole } = ariConfig.credentials;

/**
 * Main program setup
 */
const program = new Command();
program
    .name('ari')
    .description(
        'ARI CLI — shared tooling for Alliance for Responsible Infrastructure AWS accounts.',
    )
    .version(versionString);

/* Init command */
program
    .command('init')
    .description(
        "Set up this machine's local ARI config (SSO URL, region, account IDs).",
    )
    .addOption(
        new Option(
            '--from-file <path>',
            "copy a teammate's shared config instead of entering values by hand",
        ),
    )
    .addOption(
        new Option(
            '--force',
            'skip the overwrite confirmation if a local config already exists',
        ).default(false),
    )
    .action(init);

/* Credentials command */
program
    .command('credentials')
    .description(
        'Authenticate with an ARI AWS account via SSO and activate credentials.',
    )
    .addOption(
        new Option(
            '-a, --account <name>',
            'ARI account to authenticate against',
        ).choices(Object.keys(accounts)),
    )
    .addOption(
        new Option('-r, --role <name>', 'IAM role to assume')
            .choices(roles)
            .default(defaultRole),
    )
    .addOption(
        new Option(
            '-l, --list',
            'list available accounts and roles, then exit',
        ).default(false),
    )
    .addOption(
        new Option(
            '--print',
            'print credentials as export statements (does not activate the profile)',
        ).default(false),
    )
    .addOption(
        new Option(
            '--force',
            'force a fresh SSO login even if cached credentials appear valid',
        ).default(false),
    )
    .option('--debug', 'prints debug statements.', false)
    .action(credentials);

/* Pipeline commands */
const pipelineProgram = program
    .command('pipeline')
    .description('Deploy, run, monitor, and stop named ari-iac pipelines.');

pipelineProgram
    .command('deploy <name>')
    .description(
        "Deploy a named pipeline's stack (run from inside that pipeline's own repo directory).",
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.deploy({ ...options, name }));

const regionOption = () =>
    new Option(
        '--region <region>',
        'AWS region the pipeline is deployed in',
    ).default('us-east-1');
const waitOptions = (cmd) =>
    cmd
        .option('--interval <sec>', 'seconds between polls (min 2)', '5')
        .option(
            '--timeout <dur>',
            'give up waiting after e.g. 90s, 15m, 2h (the run keeps going; exit 3)',
            'none',
        )
        .option(
            '--json',
            'print one final JSON object instead of progress text',
            false,
        );

waitOptions(
    pipelineProgram
        .command('run <name>')
        .description('Start an execution of a named pipeline.')
        .addOption(regionOption())
        .addOption(
            new Option(
                '--run-id <id>',
                'reuse a specific runId (e.g. one already loaded with data) instead of generating a new one',
            ),
        )
        .option(
            '--wait',
            'wait for the run to finish (exit code reflects result)',
            false,
        ),
)
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.run({ ...options, name }));

waitOptions(
    pipelineProgram
        .command('wait <name> <runId>')
        .description(
            'Wait for a run to finish. Exit: 0 succeeded, 10 failed, 11 timed out, 12 aborted, 3 --timeout, 4 credentials expired, 130 Ctrl-C.',
        )
        .addOption(regionOption()),
)
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.wait({ ...options, name, runId }),
    );

pipelineProgram
    .command('status <name> <runId>')
    .description('Check the status of a pipeline run.')
    .addOption(regionOption())
    .option(
        '--show-output',
        'also print the execution output (may contain protected content)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.status({ ...options, name, runId }),
    );

pipelineProgram
    .command('runs <name>')
    .description('List runs (executions) of a pipeline, newest first.')
    .addOption(regionOption())
    .addOption(
        new Option('--status <status>', 'only runs with this status').choices([
            'RUNNING',
            'SUCCEEDED',
            'FAILED',
            'TIMED_OUT',
            'ABORTED',
        ]),
    )
    .option('--limit <n>', 'maximum runs to show', '20')
    .option('--all', 'show every retained run (follows pagination)', false)
    .option('--json', 'print JSON instead of a table', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.runs({ ...options, name }));

pipelineProgram
    .command('stop <name> <runId>')
    .description(
        'Stop a RUNNING run (asks for confirmation; in-flight Lambda work is not cancelled).',
    )
    .addOption(regionOption())
    .option('--cause <text>', 'cause recorded on the execution')
    .option(
        '-y, --yes',
        'skip the confirmation prompt (required when not on a terminal)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.stop({ ...options, name, runId }),
    );

pipelineProgram
    .command('history <name> <runId>')
    .description(
        'Show what a run did, one row per state (names, timings, attempts, error codes; never payloads).',
    )
    .addOption(regionOption())
    .option('--failed-only', 'only states that failed or retried', false)
    .option(
        '--show-cause',
        'also print failure causes, truncated (may contain protected content)',
        false,
    )
    .option('--json', 'print the folded structure as JSON', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.history({ ...options, name, runId }),
    );

pipelineProgram
    .command('logs <name> <runId>')
    .description("Show a run's CloudWatch log events (fixed-format lines only).")
    .addOption(regionOption())
    .addOption(
        new Option(
            '--source <source>',
            'log source: sfn (state machine), lambda (step runners; needs the manifest), or all',
        )
            .choices(['sfn', 'lambda', 'all'])
            .default('sfn'),
    )
    .option('--follow', 'keep polling until the run finishes', false)
    .option('--since <dur>', 'start window, e.g. 15m (default: run start)')
    .option('--limit <n>', 'maximum lines (ignored with --follow)', '200')
    .option('--full', 'do not truncate lines to 500 characters', false)
    .option('--json', 'print one JSON object per line', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.logs({ ...options, name, runId }),
    );

program.parse();
