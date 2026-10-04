/**
 * Tests for CredentialsCommand — account/role resolution and command
 * sequencing for `ari credentials`. All AWS/SSO calls are mocked.
 */
import { jest, describe, expect, test } from '@jest/globals';

jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('#src/lib/local-config.js', () => ({
    getLocalConfigPath: jest.fn(() => '/fake/home/.ari/config.json'),
    readLocalConfig: jest.fn(() => ({
        ssoStartUrl: 'https://d-example.awsapps.com/start',
        ssoRegion: 'us-east-1',
        accounts: {
            management: { accountId: '111111111111' },
            controlled: { accountId: '222222222222' },
            public: { accountId: '333333333333' },
        },
    })),
    writeLocalConfig: jest.fn(),
}));

jest.unstable_mockModule('#src/lib/cli/aws.js', () => ({
    configureSsoProfile: jest.fn().mockResolvedValue(undefined),
    ssoLogin: jest.fn().mockResolvedValue(undefined),
    getCredentials: jest.fn().mockResolvedValue({
        AccessKeyId: 'AKIAEXAMPLE',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        Expiration: '2026-01-01T00:00:00.000Z',
    }),
    isCredentialValid: jest.fn().mockResolvedValue(false),
    writeDefaultCredentials: jest.fn().mockResolvedValue(undefined),
    verifyCredentials: jest.fn().mockResolvedValue({
        valid: true,
        arn: 'arn:aws:iam::123456789012:user/me',
    }),
}));

const { readLocalConfig } = await import('#src/lib/local-config.js');
const { default: CredentialsCommand } =
    await import('#src/classes/credentials.js');

describe('CredentialsCommand — account/role resolution', () => {
    test('resolves profileName from account + explicit role', () => {
        const cmd = new CredentialsCommand({
            account: 'public',
            role: 'AdministratorAccess',
        });
        expect(cmd.accountKey).toBe('public');
        expect(cmd.accountName).toBe('ari-public');
        expect(cmd.roleName).toBe('AdministratorAccess');
        expect(cmd.profileName).toBe('ari-public-AdministratorAccess');
    });

    test('defaults to ViewOnlyAccess when --role is omitted', () => {
        const cmd = new CredentialsCommand({ account: 'management' });
        expect(cmd.roleName).toBe('ViewOnlyAccess');
        expect(cmd.profileName).toBe('ari-management-ViewOnlyAccess');
    });

    test('resolves each configured account', () => {
        for (const account of ['management', 'controlled', 'public']) {
            const cmd = new CredentialsCommand({ account });
            expect(cmd.accountKey).toBe(account);
        }
    });
});

describe('CredentialsCommand — action queue', () => {
    test('default mode runs version check before the credential actions', () => {
        const cmd = new CredentialsCommand({ account: 'public' });
        const names = cmd.cmdQueue.map((f) => f.name);
        expect(names).toEqual([
            'executeVersionCheck',
            'executeSetupProfile',
            'executeLogin',
            'executeHandleCredentials',
        ]);
    });

    test('--print mode skips the version check', () => {
        const cmd = new CredentialsCommand({ account: 'public', print: true });
        const names = cmd.cmdQueue.map((f) => f.name);
        expect(names).toEqual([
            'executeSetupProfile',
            'executeLogin',
            'executeHandleCredentials',
        ]);
    });
});

describe('CredentialsCommand — full run', () => {
    test('executes without throwing for a known account', async () => {
        const cmd = new CredentialsCommand({ account: 'public' });
        await expect(cmd.execute()).resolves.toBeUndefined();
    });
});

describe('CredentialsCommand — missing local config', () => {
    test('exits with a friendly "run ari init" message when ~/.ari/config.json is missing', () => {
        readLocalConfig.mockReturnValueOnce(null);
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit');
        });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        expect(() => new CredentialsCommand({ account: 'public' })).toThrow(
            'process.exit',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(
            logSpy.mock.calls
                .flat()
                .some((arg) => String(arg).includes('ari init')),
        ).toBe(true);

        exitSpy.mockRestore();
        logSpy.mockRestore();
    });

    test('exits with a friendly message when an account has no local account ID', () => {
        readLocalConfig.mockReturnValueOnce({
            ssoStartUrl: 'https://d-example.awsapps.com/start',
            ssoRegion: 'us-east-1',
            accounts: {}, // no account IDs configured yet
        });
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit');
        });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        expect(() => new CredentialsCommand({ account: 'public' })).toThrow(
            'process.exit',
        );
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
        logSpy.mockRestore();
    });
});
