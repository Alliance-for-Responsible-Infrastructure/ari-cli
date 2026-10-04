import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
    SSOOIDCClient,
    RegisterClientCommand,
    StartDeviceAuthorizationCommand,
    CreateTokenCommand,
} from '@aws-sdk/client-sso-oidc';
import { SSOClient, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import open from 'open';

const OIDC_CLIENT_NAME = 'ari-cli';
const OIDC_CLIENT_TYPE = 'public';
// Required for the resulting access token to be usable against the SSO
// portal API (sso:ListAccounts / sso:GetRoleCredentials).
const OIDC_SCOPES = ['sso:account:access'];

// Same cache location/format AWS CLI v2 uses for `aws sso login` — reading
// and writing here means an SSO session started with the AWS CLI (if it's
// ever installed) is recognized by ari-cli, and vice versa.
function ssoCacheDir() {
    return path.join(os.homedir(), '.aws', 'sso', 'cache');
}

function ssoCacheFile(ssoStartUrl) {
    const hash = crypto.createHash('sha1').update(ssoStartUrl).digest('hex');
    return path.join(ssoCacheDir(), `${hash}.json`);
}

function readSsoCache(ssoStartUrl) {
    const file = ssoCacheFile(ssoStartUrl);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

function writeSsoCache(ssoStartUrl, data) {
    const dir = ssoCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ssoCacheFile(ssoStartUrl), JSON.stringify(data, null, 2), {
        mode: 0o600,
    });
}

function isNotExpired(isoTimestamp, skewMs = 60_000) {
    return (
        !!isoTimestamp && new Date(isoTimestamp).getTime() > Date.now() + skewMs
    );
}

/**
 * Whether there's a cached SSO access token that's still valid — no network
 * call, just a local file + expiry check.
 * @param {string} ssoStartUrl
 * @returns {boolean}
 */
export function isSsoSessionValid(ssoStartUrl) {
    const cached = readSsoCache(ssoStartUrl);
    return isNotExpired(cached?.expiresAt);
}

/**
 * Ensures a valid cached SSO access token exists, performing the OIDC device
 * authorization flow (in-process, via the AWS SDK — no `aws` CLI required)
 * if there's no valid cached session. Opens the verification URL in the
 * user's browser and polls until they approve it.
 *
 * @param {string} ssoStartUrl
 * @param {string} ssoRegion
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - skip the cache and force a fresh login
 * @param {(...args: any[]) => void} [options.log=console.log]
 * @returns {Promise<string>} the (possibly newly obtained) access token
 */
export async function ssoLogin(
    ssoStartUrl,
    ssoRegion,
    { force = false, log = console.log } = {},
) {
    if (!force) {
        const cached = readSsoCache(ssoStartUrl);
        if (isNotExpired(cached?.expiresAt)) return cached.accessToken;
    }

    const oidc = new SSOOIDCClient({ region: ssoRegion });

    const client = await oidc.send(
        new RegisterClientCommand({
            clientName: OIDC_CLIENT_NAME,
            clientType: OIDC_CLIENT_TYPE,
            scopes: OIDC_SCOPES,
        }),
    );

    const deviceAuth = await oidc.send(
        new StartDeviceAuthorizationCommand({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            startUrl: ssoStartUrl,
        }),
    );

    log(`Verification code: ${deviceAuth.userCode}`);
    log(
        `Opening ${deviceAuth.verificationUriComplete} — approve the request there.`,
    );
    await open(deviceAuth.verificationUriComplete);

    let intervalMs = (deviceAuth.interval || 5) * 1000;
    const deadline = Date.now() + (deviceAuth.expiresIn || 600) * 1000;

    for (;;) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for SSO login approval.');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));

        try {
            const token = await oidc.send(
                new CreateTokenCommand({
                    clientId: client.clientId,
                    clientSecret: client.clientSecret,
                    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
                    deviceCode: deviceAuth.deviceCode,
                }),
            );

            const expiresAt = new Date(
                Date.now() + token.expiresIn * 1000,
            ).toISOString();
            writeSsoCache(ssoStartUrl, {
                startUrl: ssoStartUrl,
                region: ssoRegion,
                accessToken: token.accessToken,
                expiresAt,
            });
            return token.accessToken;
        } catch (e) {
            if (e.name === 'AuthorizationPendingException') continue;
            if (e.name === 'SlowDownException') {
                intervalMs += 5000;
                continue;
            }
            if (e.name === 'AccessDeniedException') {
                throw new Error('Login request was declined.');
            }
            if (e.name === 'ExpiredTokenException') {
                throw new Error(
                    'The login request expired before it was approved.',
                );
            }
            throw e;
        }
    }
}

/**
 * Fetches short-term role credentials directly from the SSO portal API,
 * using a cached access token (see ssoLogin). Throws if there's no valid
 * cached session — callers should run ssoLogin first.
 *
 * @param {Object} params
 * @param {string} params.ssoStartUrl
 * @param {string} params.ssoRegion
 * @param {string} params.accountId
 * @param {string} params.roleName
 * @returns {Promise<{AccessKeyId: string, SecretAccessKey: string, SessionToken: string, Expiration?: string}>}
 */
export async function getCredentials({
    ssoStartUrl,
    ssoRegion,
    accountId,
    roleName,
}) {
    const cached = readSsoCache(ssoStartUrl);
    if (!isNotExpired(cached?.expiresAt)) {
        throw new Error(
            'No active SSO session — run `ari credentials` again to log in.',
        );
    }

    const sso = new SSOClient({ region: ssoRegion });
    const { roleCredentials } = await sso.send(
        new GetRoleCredentialsCommand({
            accessToken: cached.accessToken,
            accountId,
            roleName,
        }),
    );

    return {
        AccessKeyId: roleCredentials.accessKeyId,
        SecretAccessKey: roleCredentials.secretAccessKey,
        SessionToken: roleCredentials.sessionToken,
        Expiration: new Date(roleCredentials.expiration).toISOString(),
    };
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

// --- ~/.aws/credentials (INI) read/write, no `aws` CLI required ---

function parseIni(content) {
    const sections = {};
    let current = null;
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            current = sectionMatch[1];
            sections[current] ??= {};
            continue;
        }
        const kv = line.match(/^([^=]+)=(.*)$/);
        if (kv && current) {
            sections[current][kv[1].trim()] = kv[2].trim();
        }
    }
    return sections;
}

function stringifyIni(sections) {
    const lines = [];
    for (const [section, kv] of Object.entries(sections)) {
        lines.push(`[${section}]`);
        for (const [key, value] of Object.entries(kv)) {
            lines.push(`${key} = ${value}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function credentialsFilePath() {
    return path.join(os.homedir(), '.aws', 'credentials');
}

/**
 * Write temporary STS-style credentials into ~/.aws/credentials, preserving
 * any other profiles already in the file. Omit profileName (or pass null)
 * to write to [default]; pass a profile name to write to a named section.
 *
 * @param {Object} creds
 * @param {string} creds.AccessKeyId
 * @param {string} creds.SecretAccessKey
 * @param {string} creds.SessionToken
 * @param {string|null} [profileName=null] - target profile; null → [default]
 */
export function writeDefaultCredentials(
    { AccessKeyId, SecretAccessKey, SessionToken },
    profileName = null,
) {
    const filePath = credentialsFilePath();
    const sections = fs.existsSync(filePath)
        ? parseIni(fs.readFileSync(filePath, 'utf-8'))
        : {};

    sections[profileName || 'default'] = {
        aws_access_key_id: AccessKeyId,
        aws_secret_access_key: SecretAccessKey,
        aws_session_token: SessionToken,
    };

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, stringifyIni(sections), { mode: 0o600 });
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
