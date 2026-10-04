import { styles } from '#src/lib/cli/terminal.js';
import {
    isSsoSessionValid,
    ssoLogin,
    getCredentials,
    writeDefaultCredentials,
    verifyCredentials,
} from '#src/lib/cli/aws.js';
import BaseAriCommand from './base-command.js';

const { success, error, emphasis, bold } = styles;

/**
 * Prints the accounts/roles configured in ari-config.json, for
 * `ari credentials --list`.
 * @param {Object} ariConfig
 */
export function printAccountsList(ariConfig) {
    const { accounts, roles, defaultRole } = ariConfig.credentials;

    console.log(bold('Available accounts (--account):'));
    for (const [key, { name }] of Object.entries(accounts)) {
        console.log(`  ${emphasis(key)}  ${name}`);
    }

    console.log();
    console.log(bold('Available roles (--role):'));
    for (const role of roles) {
        const marker = role === defaultRole ? ' (default)' : '';
        console.log(`  ${emphasis(role)}${marker}`);
    }
}

export default class CredentialsCommand extends BaseAriCommand {
    constructor(options) {
        super(options);

        const config = this.ariConfig.credentials;
        const accountKey = options.account;

        if (!config.accounts[accountKey]) {
            console.log(
                error('Error:'),
                `Unknown account "${accountKey}". Run "ari credentials --list" to see available accounts.`,
            );
            process.exit(1);
        }

        if (!this.localConfig) {
            console.log(error('Error:'), 'No local ARI config found.');
            console.log(
                'Run',
                emphasis('ari init'),
                'to set it up (you only need to do this once per machine).',
            );
            process.exit(1);
        }

        const accountConfig = this.getAccountConfig(accountKey);
        if (!accountConfig) {
            console.log(
                error('Error:'),
                `No account ID configured locally for "${accountKey}".`,
            );
            console.log(
                'Run',
                emphasis('ari init'),
                "to add it, or ask an admin for your org's config.",
            );
            process.exit(1);
        }

        this.accountKey = accountKey;
        this.accountName = accountConfig.name;
        this.accountId = accountConfig.accountId;
        this.roleName = options.role || config.defaultRole;
        this.ssoStartUrl = this.localConfig.ssoStartUrl;
        this.ssoRegion = this.localConfig.ssoRegion;

        // e.g. "ari-public-ViewOnlyAccess"
        this.profileName = `ari-${this.accountKey}-${this.roleName}`;

        this.addActions();
    }

    /**
     * Routes log output to stderr in --print mode so that stdout stays clean
     * for shell command substitution: eval $(ari credentials --print)
     */
    #log(...args) {
        if (this.options.print) {
            console.error(...args);
        } else {
            console.log(...args);
        }
    }

    async executeLogin() {
        if (!this.options.force && isSsoSessionValid(this.ssoStartUrl)) {
            this.#log(
                success('Session active.'),
                'Skipping SSO login — cached session is still valid.',
            );
            return;
        }
        this.#log(emphasis('Opening AWS SSO login in your browser...'));
        await ssoLogin(this.ssoStartUrl, this.ssoRegion, {
            force: this.options.force,
            log: (...args) => this.#log(...args),
        });
    }

    async executeHandleCredentials() {
        if (this.options.print) {
            await this.#printCredentials();
        } else {
            await this.#activateCredentials();
        }
    }

    /**
     * Wraps getCredentials with a human-friendly error for the common case
     * where the role is not assigned to the user in IAM Identity Center.
     * Collaborators aren't expected to know what IAM Identity Center is, so
     * the message points them at --list and their AWS administrator instead.
     */
    async #fetchCredentials() {
        try {
            return await getCredentials({
                ssoStartUrl: this.ssoStartUrl,
                ssoRegion: this.ssoRegion,
                accountId: this.accountId,
                roleName: this.roleName,
            });
        } catch (e) {
            if (
                e.name === 'UnauthorizedException' ||
                e.message?.includes('not authorized')
            ) {
                console.error(
                    error('Error:'),
                    `You don't have "${this.roleName}" access to ${emphasis(this.accountName)}.`,
                );
                console.error(
                    'Run "ari credentials --list" to see the accounts and roles available to you, or contact your AWS administrator.',
                );
                process.exit(1);
            }
            throw e;
        }
    }

    /**
     * Default (no --print): export credentials from the SSO profile and write
     * them to ~/.aws/credentials under [default] so all AWS tools pick them up
     * automatically — no subsequent `export AWS_PROFILE=...` needed.
     */
    async #activateCredentials() {
        this.#log(emphasis('Activating credentials...'));
        const creds = await this.#fetchCredentials();

        this.#log(
            `Key ID: ${emphasis(creds.AccessKeyId?.slice(0, 8) + '...')}`,
            creds.Expiration
                ? `  Expires: ${new Date(creds.Expiration).toLocaleString()}`
                : '  (no expiration returned)',
        );

        const {
            valid,
            arn,
            error: verifyError,
        } = await verifyCredentials(creds);
        if (!valid) {
            console.log(
                error('Error:'),
                `Credential verification failed — the fetched credentials are not accepted by AWS: ${verifyError}`,
            );
            console.log(
                'Try re-running with --force to trigger a fresh SSO login.',
            );
            process.exit(1);
        }
        this.#log(success('Verified:'), arn);

        // Write to [default] for tools that don't consult AWS_PROFILE, and also
        // to the named profile so tools that inherit AWS_PROFILE from the shell
        // get fresh static credentials instead of a stale SSO cache.
        await writeDefaultCredentials(creds);
        await writeDefaultCredentials(creds, this.profileName);
        console.log(
            success('Success:'),
            `Credentials for ${emphasis(this.accountName)} (${this.roleName}) are now active.`,
        );
        if (creds.Expiration) {
            console.log(
                `Session expires: ${emphasis(new Date(creds.Expiration).toLocaleString())}`,
            );
        }
    }

    /**
     * --print mode: write raw export statements to stdout only so the caller
     * can source them directly:
     *
     *   eval $(ari credentials --account public --print)
     *
     * All other output (status messages, errors) is routed to stderr so it
     * does not interfere with the eval.
     */
    async #printCredentials() {
        this.#log(emphasis('Exporting credentials to stdout...'));
        const creds = await this.#fetchCredentials();
        process.stdout.write(`export AWS_ACCESS_KEY_ID=${creds.AccessKeyId}\n`);
        process.stdout.write(
            `export AWS_SECRET_ACCESS_KEY=${creds.SecretAccessKey}\n`,
        );
        process.stdout.write(
            `export AWS_SESSION_TOKEN=${creds.SessionToken}\n`,
        );
        if (creds.Expiration) {
            process.stdout.write(
                `export AWS_CREDENTIAL_EXPIRATION=${creds.Expiration}\n`,
            );
        }
    }

    addActions() {
        if (!this.options.print) {
            super.addActions();
        }
        this.addAction(this.executeLogin);
        this.addAction(this.executeHandleCredentials);
    }
}
