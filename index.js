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
    .description(
        'Deploy, run, and check the status of named ari-iac pipelines.',
    );

pipelineProgram
    .command('deploy <name>')
    .description(
        "Deploy a named pipeline's stack (run from inside that pipeline's own repo directory).",
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.deploy({ ...options, name }));

pipelineProgram
    .command('run <name>')
    .description('Start an execution of a named pipeline.')
    .addOption(
        new Option(
            '--region <region>',
            'AWS region the pipeline is deployed in',
        ).default('us-east-1'),
    )
    .addOption(
        new Option(
            '--run-id <id>',
            'reuse a specific runId (e.g. one already loaded with data) instead of generating a new one',
        ),
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, options) => pipeline.run({ ...options, name }));

pipelineProgram
    .command('status <name> <runId>')
    .description('Check the status of a pipeline run.')
    .addOption(
        new Option(
            '--region <region>',
            'AWS region the pipeline is deployed in',
        ).default('us-east-1'),
    )
    .option('--debug', 'prints debug statements.', false)
    .action((name, runId, options) =>
        pipeline.status({ ...options, name, runId }),
    );

program.parse();
