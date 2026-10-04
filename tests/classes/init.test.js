/**
 * Tests for InitCommand's --from-file path (validation + save). The
 * interactive wizard (readline prompts) isn't covered here — --from-file
 * exercises the same #validate logic without needing a TTY.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, expect, test, afterEach } from '@jest/globals';

jest.unstable_mockModule('#src/lib/local-config.js', () => ({
    getLocalConfigPath: jest.fn(() => '/fake/home/.ari/config.json'),
    readLocalConfig: jest.fn(() => null),
    writeLocalConfig: jest.fn(),
}));

const { writeLocalConfig } = await import('#src/lib/local-config.js');
const { default: InitCommand } = await import('#src/classes/init.js');

function writeTempConfig(data) {
    const file = path.join(
        os.tmpdir(),
        `ari-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
}

const VALID_CONFIG = {
    ssoStartUrl: 'https://d-example.awsapps.com/start',
    ssoRegion: 'us-east-1',
    accounts: {
        management: { accountId: '111111111111' },
        controlled: { accountId: '222222222222' },
        public: { accountId: '333333333333' },
    },
};

describe('InitCommand — --from-file', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('saves a valid shared config as-is', async () => {
        const file = writeTempConfig(VALID_CONFIG);
        const cmd = new InitCommand({ fromFile: file });

        const exitSpy = jest
            .spyOn(process, 'exit')
            .mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});

        await cmd.run();

        expect(writeLocalConfig).toHaveBeenCalledWith(VALID_CONFIG);
        expect(exitSpy).not.toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
        console.log.mockRestore();
        fs.unlinkSync(file);
    });

    test.each([
        [
            'bad ssoStartUrl',
            { ...VALID_CONFIG, ssoStartUrl: 'http://not-https.example.com' },
        ],
        ['bad ssoRegion', { ...VALID_CONFIG, ssoRegion: 'not-a-region' }],
        [
            'non-12-digit account ID',
            {
                ...VALID_CONFIG,
                accounts: {
                    ...VALID_CONFIG.accounts,
                    public: { accountId: '123' },
                },
            },
        ],
        [
            'missing account entirely',
            {
                ...VALID_CONFIG,
                accounts: {
                    management: VALID_CONFIG.accounts.management,
                    controlled: VALID_CONFIG.accounts.controlled,
                },
            },
        ],
    ])('rejects %s without writing local config', async (_label, badData) => {
        const file = writeTempConfig(badData);
        const cmd = new InitCommand({ fromFile: file });

        const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit');
        });
        jest.spyOn(console, 'log').mockImplementation(() => {});

        await expect(cmd.run()).rejects.toThrow('process.exit');

        expect(writeLocalConfig).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
        console.log.mockRestore();
        fs.unlinkSync(file);
    });
});
