/**
 * Tests for BaseAriCommand — the queue execution engine that every command
 * in ari-cli inherits from.
 */
import { jest, describe, expect, test } from '@jest/globals';

// Mock versionCheck so tests don't hit the network or exit the process
jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));

const { default: BaseAriCommand } =
    await import('#src/classes/base-command.js');

function makeCommand(options = {}) {
    return new BaseAriCommand(options);
}

describe('BaseAriCommand — addAction / addFinally', () => {
    test('addAction enqueues a function by name', () => {
        const cmd = makeCommand();
        async function myAction() {}
        cmd.addAction(myAction);
        expect(cmd.cmdQueue).toHaveLength(1);
        expect(cmd.cmdQueue[0].name).toBe('myAction');
    });

    test('addFinally enqueues a function into the finally queue', () => {
        const cmd = makeCommand();
        async function cleanup() {}
        cmd.addFinally(cleanup);
        expect(cmd.finallyQueue).toHaveLength(1);
        expect(cmd.finallyQueue[0].name).toBe('cleanup');
    });

    test('addAction throws when given a non-function', () => {
        const cmd = makeCommand();
        expect(() => cmd.addAction('not a function')).toThrow(
            'Only functions can be added to the queue',
        );
    });

    test('addFinally throws when given a non-function', () => {
        const cmd = makeCommand();
        expect(() => cmd.addFinally(42)).toThrow(
            'Only functions can be added to the finally queue',
        );
    });

    test('multiple addAction calls preserve insertion order', () => {
        const cmd = makeCommand();
        async function first() {}
        async function second() {}
        async function third() {}
        cmd.addAction(first);
        cmd.addAction(second);
        cmd.addAction(third);
        const names = cmd.cmdQueue.map((f) => f.name);
        expect(names).toEqual(['first', 'second', 'third']);
    });
});

describe('BaseAriCommand — haltProcessing', () => {
    test('setting haltProcessing stops the queue mid-execution', async () => {
        const cmd = makeCommand();
        const calls = [];

        async function first() {
            calls.push('first');
            cmd.haltProcessing();
        }
        async function second() {
            calls.push('second');
        }

        cmd.addAction(first);
        cmd.addAction(second);
        await cmd.execute();

        expect(calls).toEqual(['first']);
        expect(calls).not.toContain('second');
    });

    test('finallyQueue still runs after haltProcessing', async () => {
        const cmd = makeCommand();
        const calls = [];

        async function action() {
            calls.push('action');
            cmd.haltProcessing();
        }
        async function cleanup() {
            calls.push('cleanup');
        }

        cmd.addAction(action);
        cmd.addFinally(cleanup);
        await cmd.execute();

        expect(calls).toContain('action');
        expect(calls).toContain('cleanup');
    });
});

describe('BaseAriCommand — execute', () => {
    test('executes all actions in order', async () => {
        const cmd = makeCommand();
        const order = [];

        cmd.addAction(async function a() {
            order.push('a');
        });
        cmd.addAction(async function b() {
            order.push('b');
        });
        cmd.addAction(async function c() {
            order.push('c');
        });

        await cmd.execute();
        expect(order).toEqual(['a', 'b', 'c']);
    });

    test('executes finally queue after all actions', async () => {
        const cmd = makeCommand();
        const order = [];

        cmd.addAction(async function action() {
            order.push('action');
        });
        cmd.addFinally(async function fin() {
            order.push('finally');
        });

        await cmd.execute();
        expect(order).toEqual(['action', 'finally']);
    });

    test('actions can access `this` context of the command', async () => {
        const cmd = makeCommand({ accountKey: 'public' });
        let captured;

        cmd.addAction(async function readOptions() {
            captured = this.options.accountKey;
        });

        await cmd.execute();
        expect(captured).toBe('public');
    });

    test('second execute call while processing is a no-op', async () => {
        const cmd = makeCommand();
        const calls = [];

        cmd.addAction(async function a() {
            calls.push('a');
        });

        const p1 = cmd.execute();
        const p2 = cmd.execute(); // should be ignored
        await Promise.all([p1, p2]);

        expect(calls).toEqual(['a']);
    });

    test('clears AWS credential env vars before executing', async () => {
        process.env.AWS_ACCESS_KEY_ID = 'fake-key';
        process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
        process.env.AWS_SESSION_TOKEN = 'fake-session';
        process.env.AWS_SECURITY_TOKEN = 'fake-security';

        const cmd = makeCommand();
        await cmd.execute();

        expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
        expect(process.env.AWS_SECURITY_TOKEN).toBeUndefined();
    });

    test('cmdQueue is empty after execute completes', async () => {
        const cmd = makeCommand();
        cmd.addAction(async function noop() {});
        await cmd.execute();
        expect(cmd.cmdQueue).toHaveLength(0);
    });
});

describe('BaseAriCommand — addActions with debug', () => {
    test('prepends printDebugInfo when debug is true', () => {
        const cmd = makeCommand({ debug: true });
        cmd.addActions();
        expect(cmd.cmdQueue[0].name).toBe('printDebugInfo');
    });

    test('does not prepend printDebugInfo when debug is false', () => {
        const cmd = makeCommand({ debug: false });
        cmd.addActions();
        expect(cmd.cmdQueue[0].name).toBe('executeVersionCheck');
    });

    test('addActions always adds executeVersionCheck', () => {
        const cmd = makeCommand({});
        cmd.addActions();
        const names = cmd.cmdQueue.map((f) => f.name);
        expect(names).toContain('executeVersionCheck');
    });
});
