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

const APPROVAL_MODES = ['never', 'any-change', 'broadening'];
const cwdNote =
    "(run from inside that pipeline's own repo directory; account and region come from its config/default.json and ~/.ari/config.json, so there is no --region or --profile)";

pipelineProgram
    .command('deploy <name>')
    .description(
        `Deploy a named pipeline's stack, behind an account guard ${cwdNote}.`,
    )
    .addOption(
        new Option(
            '--require-approval <mode>',
            "pass through to cdk (default: cdk's own, broadening)",
        ).choices(APPROVAL_MODES),
    )
    .option(
        '--bootstrap',
        'run "cdk bootstrap" for the account/region first (after confirmation)',
        false,
    )
    .option(
        '--yes',
        'skip confirmations (required off a TTY for --bootstrap and --require-approval never)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.deploy({ ...options, name }));

pipelineProgram
    .command('diff <name>')
    .description(
        `Show "cdk diff" for a named pipeline, behind the account guard ${cwdNote}.`,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.diff({ ...options, name }));

pipelineProgram
    .command('synth <name>')
    .description(
        `Run "cdk synth" for a named pipeline, behind the account guard ${cwdNote}.`,
    )
    .option('--quiet', 'do not print the template to stdout', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.synth({ ...options, name }));

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

pipelineProgram
    .command('fetch <name> <runId>')
    .description(
        "Download the run's result file (the manifest's resultKey) through the protected-data gate.",
    )
    .addOption(regionOption())
    .option('--out <path>', 'output path (default ./<stage>-<runId>.<ext>)')
    .option('--force', 'overwrite an existing output file', false)
    .option(
        '-y, --yes',
        'skip the confirmation prompt (required when not on a terminal)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.fetchResult({ ...options, name, runId }),
    );

/* Pipeline data plane: `ari pipeline data ...` */
const dataProgram = pipelineProgram
    .command('data')
    .description(
        "Work with a pipeline's S3 data via its manifest. ls/load/inspect never print content; get/cat go through the protected-data gate.",
    );

dataProgram
    .command('stages <name>')
    .description("Show the pipeline's stages (from its manifest; no S3 calls).")
    .addOption(regionOption())
    .option('--json', 'print JSON', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.dataStages({ ...options, name }));

dataProgram
    .command('ls <name> <runId>')
    .description(
        "List a run's objects (keys, sizes, dates only). Without --stage: per-stage counts.",
    )
    .addOption(regionOption())
    .option('--stage <stage>', 'list this stage\'s keys')
    .option('--match <text>', 'only ids containing this text (needs --stage)')
    .option('--ids', 'bare ids, one per line (needs --stage)', false)
    .option('--json', 'print JSON', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.dataLs({ ...options, name, runId }),
    );

dataProgram
    .command('load <name> <localDir>')
    .description(
        "Upload the top-level files of a local directory to the pipeline's input stage for a run.",
    )
    .addOption(regionOption())
    .requiredOption('--run-id <id>', 'run id to load the data under')
    .option('--stage <stage>', 'a loadable stage (default: the manifest inputStage)')
    .option(
        '-y, --yes',
        'continue when the prefix already has objects (required when not on a terminal)',
        false,
    )
    .option('--debug', 'prints debug statements (also lists uploaded file names).', false)
    .action((name, localDir, options) =>
        pipeline.dataLoad({ ...options, name, localDir }),
    );

dataProgram
    .command('get <name> <runId> [id]')
    .description(
        'Download one object through the protected-data gate (readable stages only; no id = the result key).',
    )
    .addOption(regionOption())
    .option('--stage <stage>', 'stage of <id> (required with an id)')
    .option('--out <path>', 'output path')
    .option('--force', 'overwrite an existing output file', false)
    .option(
        '-y, --yes',
        'skip the confirmation prompt (required when not on a terminal)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, id, options) =>
        pipeline.dataGet({ ...options, name, runId, id }),
    );

dataProgram
    .command('inspect <name> <runId> <id>')
    .description(
        'Show an object\'s structure only (CSV columns/row count, JSON key shape, sizes); never values.',
    )
    .addOption(regionOption())
    .requiredOption('--stage <stage>', 'stage of <id>')
    .option('--json', 'print JSON', false)
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, id, options) =>
        pipeline.dataInspect({ ...options, name, runId, id }),
    );

dataProgram
    .command('cat <name> <runId> <id>')
    .description(
        'Print an object to stdout through the protected-data gate (readable stages, text only, 64 KiB default, 1 MiB max).',
    )
    .addOption(regionOption())
    .requiredOption('--stage <stage>', 'stage of <id>')
    .option('--max-bytes <n>', 'bytes to read (default 65536, max 1048576)')
    .option('--head <lines>', 'print only the first N lines')
    .option(
        '-y, --yes',
        'skip the confirmation prompt (required when not on a terminal)',
        false,
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, id, options) =>
        pipeline.dataCat({ ...options, name, runId, id }),
    );

program.parse();
