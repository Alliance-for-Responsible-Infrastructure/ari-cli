#!/usr/bin/env node
import path from 'path';
import * as url from 'url';
import { Command, Option } from 'commander';

import { versionString } from '#src/lib/program-utils.js';
import requireJSON from '#src/lib/require-json.js';
import credentials from '#src/commands/credentials.js';
import init from '#src/commands/init.js';

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

program.parse();
