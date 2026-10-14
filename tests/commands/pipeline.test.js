/**
 * runCommand: exit code mapping (`e.exitCode ?? 1` on error, `cmd.exitCode ?? 0`
 * on success).
 */
import { jest, describe, expect, test, beforeEach } from '@jest/globals';

jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));

const { runCommand } = await import('#src/commands/pipeline.js');
const { PipelineError } = await import('#src/lib/cli/pipeline-utils.js');

class Fake {
    constructor(options) {
        this.options = options;
        this.exitCode = options.exitCode;
    }
    async execute() {
        if (this.options.throws) throw this.options.throws;
    }
}

let exitSpy;
beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runCommand', () => {
    test('success exits 0 by default', async () => {
        await runCommand(Fake, {});
        expect(exitSpy).toHaveBeenLastCalledWith(0);
    });

    test('success honours cmd.exitCode (e.g. wait on a FAILED run -> 10)', async () => {
        await runCommand(Fake, { exitCode: 10 });
        expect(exitSpy).toHaveBeenLastCalledWith(10);
    });

    test('a plain error exits 1', async () => {
        await runCommand(Fake, { throws: new Error('boom') });
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('an error carrying exitCode exits with it', async () => {
        await runCommand(Fake, { throws: new PipelineError('refused', 2) });
        expect(exitSpy).toHaveBeenCalledWith(2);
    });
});
