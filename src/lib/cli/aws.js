import { exec, spawn } from 'child_process';

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromSSO } from '@aws-sdk/credential-providers';

/**
 * Attempt to login to AWS via SSO, streaming output in real-time so the
 * verification code printed by the AWS CLI is visible before the user approves
 * in the browser.
 *
 * In --print mode (useStderr: true) all output is routed to stderr so that
 * stdout stays clean for shell evaluation: eval $(ari credentials --print)
 *
 * @param {string} profile - the aws profile to login as
 * @param {Object} [options]
 * @param {boolean} [options.useStderr=false] - route all output to stderr
 * @returns {Promise<void>}
 */
export function ssoLogin(profile, { useStderr = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('aws', ['sso', 'login', '--profile', profile], {
            stdio: useStderr
                ? ['ignore', 'pipe', 'pipe']
                : ['ignore', 'inherit', 'inherit'],
        });

        if (useStderr) {
            child.stdout?.on('data', (data) => process.stderr.write(data));
            child.stderr?.on('data', (data) => process.stderr.write(data));
        }

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`aws sso login failed with code ${code}`));
        });

        child.on('error', reject);
    });
}

/**
 * Idempotently write an AWS SSO profile to ~/.aws/config using `aws configure set`.
 * Safe to call multiple times — subsequent calls overwrite the previous values.
 *
 * @param {string} profileName - the profile name to write (e.g. "ari-public-ViewOnlyAccess")
 * @param {Object} config
 * @param {string} config.accountId    - AWS account ID
 * @param {string} config.roleName     - IAM role name
 * @param {string} config.ssoStartUrl  - IAM Identity Center start URL
 * @param {string} config.ssoRegion    - region where IAM Identity Center is hosted
 * @returns {Promise<void>}
 */
export async function configureSsoProfile(
    profileName,
    { accountId, roleName, ssoStartUrl, ssoRegion },
) {
    const settings = [
        ['sso_start_url', ssoStartUrl],
        ['sso_region', ssoRegion],
        ['sso_account_id', accountId],
        ['sso_role_name', roleName],
        ['region', ssoRegion],
        ['output', 'json'],
    ];

    for (const [key, value] of settings) {
        await new Promise((resolve, reject) => {
            exec(
                `aws configure set ${key} "${value}" --profile "${profileName}"`,
                (err, _, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve();
                },
            );
        });
    }
}

/**
 * Resolve fresh credentials for a named SSO profile via the AWS SSO service.
 * Uses fromSSO which reads the SSO config from ~/.aws/config and always calls
 * the SSO service to get current role credentials — bypassing ~/.aws/credentials
 * entirely so stale static credentials written by a previous run cannot
 * interfere.
 *
 * @param {string} profileName
 * @returns {Promise<{AccessKeyId: string, SecretAccessKey: string, SessionToken: string, Expiration?: string}>}
 */
export async function getCredentials(profileName) {
    const provider = fromSSO({ profile: profileName });
    const creds = await provider();
    return {
        AccessKeyId: creds.accessKeyId,
        SecretAccessKey: creds.secretAccessKey,
        SessionToken: creds.sessionToken,
        Expiration: creds.expiration?.toISOString(),
    };
}

/**
 * Check whether the SSO session for a profile is still valid without opening
 * a browser. fromSSO calls the SSO service using the cached SSO token; if the
 * token is expired it throws, which we catch and return false.
 *
 * @param {string} profileName
 * @returns {Promise<boolean>}
 */
export async function isCredentialValid(profileName) {
    try {
        const provider = fromSSO({ profile: profileName });
        await provider();
        return true;
    } catch {
        return false;
    }
}

/**
 * Write temporary STS credentials into ~/.aws/credentials using `aws configure set`.
 * Omit profileName (or pass null) to write to [default]; pass a profile name to
 * write to a named profile. Writing to a named SSO profile overlays static
 * credentials on top of its SSO config so that tools that don't auto-refresh SSO
 * still receive valid credentials regardless of AWS_PROFILE.
 *
 * @param {Object} creds
 * @param {string} creds.AccessKeyId
 * @param {string} creds.SecretAccessKey
 * @param {string} creds.SessionToken
 * @param {string|null} [profileName=null] - target profile; null → [default]
 * @returns {Promise<void>}
 */
export async function writeDefaultCredentials(
    { AccessKeyId, SecretAccessKey, SessionToken },
    profileName = null,
) {
    const profileFlag = profileName ? ` --profile "${profileName}"` : '';
    const entries = [
        ['aws_access_key_id', AccessKeyId],
        ['aws_secret_access_key', SecretAccessKey],
        ['aws_session_token', SessionToken],
    ];

    for (const [key, value] of entries) {
        await new Promise((resolve, reject) => {
            exec(
                `aws configure set ${key} "${value}"${profileFlag}`,
                (err, _, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve();
                },
            );
        });
    }
}

/**
 * Verify a set of credentials are actually accepted by AWS by calling
 * sts:GetCallerIdentity with the credentials passed directly — no profile
 * or environment variable lookup so the result is unambiguous.
 *
 * @param {Object} creds
 * @param {string} creds.AccessKeyId
 * @param {string} creds.SecretAccessKey
 * @param {string} creds.SessionToken
 * @returns {Promise<{valid: boolean, arn?: string, error?: string}>}
 */
export async function verifyCredentials({
    AccessKeyId,
    SecretAccessKey,
    SessionToken,
}) {
    try {
        const sts = new STSClient({
            region: 'us-east-1',
            credentials: {
                accessKeyId: AccessKeyId,
                secretAccessKey: SecretAccessKey,
                sessionToken: SessionToken,
            },
        });
        const { Arn } = await sts.send(new GetCallerIdentityCommand({}));
        return { valid: true, arn: Arn };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

/**
 * Returns a copy of process.env with all AWS credential environment variables
 * removed. Pass this as the `env` option to any subprocess that should use
 * ~/.aws credential files rather than stale shell-level AWS_ACCESS_KEY_ID /
 * AWS_SESSION_TOKEN variables that may be lingering from a previous
 * `eval $(ari credentials --print)` invocation.
 *
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanAwsEnv() {
    const env = { ...process.env };
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    delete env.AWS_SECURITY_TOKEN; // legacy alias
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;
    return env;
}
