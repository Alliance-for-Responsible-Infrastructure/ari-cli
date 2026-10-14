/**
 * Tests for the deploy-guard helpers in src/lib/cli/aws.js. No AWS: clients
 * are injected fakes.
 */
import { describe, expect, test, jest } from '@jest/globals';
import { getBootstrapVersion, getCallerAccount } from '#src/lib/cli/aws.js';

describe('getCallerAccount', () => {
    test('returns the STS account id', async () => {
        const send = jest.fn().mockResolvedValue({ Account: '123456789012' });
        await expect(
            getCallerAccount('us-east-1', { createSts: () => ({ send }) }),
        ).resolves.toBe('123456789012');
    });
});

describe('getBootstrapVersion', () => {
    test('reads /cdk-bootstrap/<qualifier>/version', async () => {
        const send = jest
            .fn()
            .mockResolvedValue({ Parameter: { Value: '21' } });
        await expect(
            getBootstrapVersion('hnb659fds', 'us-east-1', {
                createSsm: () => ({ send }),
            }),
        ).resolves.toBe('21');
        expect(send.mock.calls[0][0].input).toEqual({
            Name: '/cdk-bootstrap/hnb659fds/version',
        });
    });

    test('ParameterNotFound -> null; other errors propagate', async () => {
        const notFound = Object.assign(new Error('x'), {
            name: 'ParameterNotFound',
        });
        await expect(
            getBootstrapVersion('q', 'us-east-1', {
                createSsm: () => ({
                    send: jest.fn().mockRejectedValue(notFound),
                }),
            }),
        ).resolves.toBeNull();
        const denied = Object.assign(new Error('no'), {
            name: 'AccessDeniedException',
        });
        await expect(
            getBootstrapVersion('q', 'us-east-1', {
                createSsm: () => ({
                    send: jest.fn().mockRejectedValue(denied),
                }),
            }),
        ).rejects.toThrow('no');
    });
});
