import path from 'path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { styles } from '#src/lib/cli/terminal.js';
import requireJSON from '#src/lib/require-json.js';
import {
    getLocalConfigPath,
    readLocalConfig,
    writeLocalConfig,
} from '#src/lib/local-config.js';
import BaseAriEntity from './base-entity.js';

const { success, error, warn, emphasis, bold } = styles;

const ACCOUNT_ID_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

/**
 * `ari init` — collects the org-specific AWS details (SSO start URL, SSO
 * region, per-account IDs) that are deliberately NOT shipped in the repo,
 * and saves them to ~/.ari/config.json. Two ways to populate it:
 *
 *   ari init                      interactive wizard (asks for each value)
 *   ari init --from-file <path>   copies/validates a config a teammate shared
 */
export default class InitCommand extends BaseAriEntity {
    constructor(options) {
        super(options);
        this.accountKeys = Object.keys(this.ariConfig.credentials.accounts);
    }

    async run() {
        if (this.options.fromFile) {
            this.#runFromFile(this.options.fromFile);
            return;
        }
        await this.#runInteractive();
    }

    #runFromFile(filePath) {
        let data;
        try {
            data = requireJSON(path.resolve(this.cwd, filePath));
        } catch (e) {
            console.log(
                error('Error:'),
                `Could not read ${filePath}: ${e.message}`,
            );
            process.exit(1);
        }

        try {
            this.#validate(data);
        } catch (e) {
            console.log(error('Error:'), `Invalid config: ${e.message}`);
            process.exit(1);
        }

        writeLocalConfig(data);
        this.#printSuccess();
    }

    async #runInteractive() {
        const existing = readLocalConfig();

        if (existing && !this.options.force) {
            const overwrite = await this.#confirm(
                `A local config already exists at ${emphasis(getLocalConfigPath())}. Overwrite it?`,
            );
            if (!overwrite) {
                console.log('Left the existing config unchanged.');
                return;
            }
        }

        console.log(bold('ARI CLI setup'));
        console.log(
            "This saves your org's AWS SSO details locally so `ari credentials` can use them. " +
                'You only need to do this once per machine.',
        );
        console.log(
            `If a teammate already has this set up, it's easier to ask them for their ${emphasis(getLocalConfigPath())} ` +
                `file and run ${emphasis('ari init --from-file <path>')} instead of typing everything in by hand.\n`,
        );

        const rl = readline.createInterface({ input: stdin, output: stdout });
        try {
            const ssoStartUrl = await this.#ask(rl, {
                label: 'SSO start URL',
                defaultValue: existing?.ssoStartUrl,
                validate: (v) => v.startsWith('https://'),
                hint: 'must start with https://',
            });
            const ssoRegion = await this.#ask(rl, {
                label: 'SSO region (e.g. us-east-1)',
                defaultValue: existing?.ssoRegion,
                validate: (v) => REGION_RE.test(v),
                hint: 'must look like a region, e.g. us-east-1',
            });

            const accounts = {};
            for (const key of this.accountKeys) {
                const { name } = this.ariConfig.credentials.accounts[key];
                const accountId = await this.#ask(rl, {
                    label: `AWS account ID for "${name}" (${key})`,
                    defaultValue: existing?.accounts?.[key]?.accountId,
                    validate: (v) => ACCOUNT_ID_RE.test(v),
                    hint: 'must be a 12-digit AWS account ID',
                });
                accounts[key] = { accountId };
            }

            writeLocalConfig({ ssoStartUrl, ssoRegion, accounts });
            this.#printSuccess();
        } finally {
            rl.close();
        }
    }

    async #ask(rl, { label, defaultValue, validate, hint }) {
        const suffix = defaultValue ? ` (${defaultValue})` : '';
        for (;;) {
            const answer = (await rl.question(`${label}${suffix}: `)).trim();
            const value = answer || defaultValue;
            if (value && validate(value)) return value;
            console.log(warn('Invalid:'), hint);
        }
    }

    async #confirm(label) {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        try {
            const answer = (await rl.question(`${label} (y/N): `))
                .trim()
                .toLowerCase();
            return answer === 'y' || answer === 'yes';
        } finally {
            rl.close();
        }
    }

    #validate(data) {
        if (!data.ssoStartUrl?.startsWith('https://')) {
            throw new Error('ssoStartUrl must start with https://');
        }
        if (!REGION_RE.test(data.ssoRegion || '')) {
            throw new Error(
                'ssoRegion must look like a region, e.g. us-east-1',
            );
        }
        for (const key of this.accountKeys) {
            const accountId = data.accounts?.[key]?.accountId;
            if (!ACCOUNT_ID_RE.test(accountId || '')) {
                throw new Error(
                    `accounts.${key}.accountId must be a 12-digit AWS account ID`,
                );
            }
        }
    }

    #printSuccess() {
        console.log();
        console.log(success('Saved:'), getLocalConfigPath());
        console.log(
            'Run "ari credentials --list" to confirm, then "ari credentials --account <name>" to log in.',
        );
    }
}
