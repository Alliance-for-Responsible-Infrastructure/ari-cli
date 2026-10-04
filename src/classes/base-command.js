import { styles } from '#src/lib/cli/terminal.js';
import versionCheck from '#src/lib/version-check.js';
import BaseAriEntity from './base-entity.js';

const { emphasis } = styles;

/**
 * Base class for all ARI commands
 */
export default class BaseAriCommand extends BaseAriEntity {
    constructor(options) {
        super(options);

        this.cmdQueue = [];
        this.finallyQueue = [];
        this.isProcessing = false;
    }

    async executeVersionCheck() {
        await versionCheck();
    }

    haltProcessing() {
        this.isProcessing = false;
    }

    printDebugInfo() {
        console.log(emphasis('Debugging Info:'));
        console.log(emphasis('------------------------'));
        console.log(emphasis('ARI CLI Options:'));
        console.log(JSON.stringify(this.options, null, '\t'), '\n');
        console.log(emphasis('------------------------'));
    }

    async executeWrappedFn(fn) {
        if (this.options.debug) {
            console.log(emphasis('Begin:'), fn.name);
        }
        await fn();
        if (this.options.debug) {
            console.log(emphasis('Complete:'), fn.name, '\n');
        }
    }

    async execute() {
        // Remove stale credential env vars that may be inherited from the shell
        // (e.g. from a previous `eval $(ari credentials --print)` session).
        // ARI commands rely on ~/.aws/credentials written by `ari credentials`
        // rather than ambient env vars, so clearing these here ensures both
        // in-process AWS SDK clients and subprocesses use the correct credentials.
        for (const key of [
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_SESSION_TOKEN',
            'AWS_SECURITY_TOKEN',
        ]) {
            delete process.env[key];
        }

        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.cmdQueue.length > 0 && this.isProcessing) {
            const fn = this.cmdQueue.shift();
            await this.executeWrappedFn(fn);
        }
        this.isProcessing = false;

        while (this.finallyQueue.length > 0) {
            const fn = this.finallyQueue.shift();
            await this.executeWrappedFn(fn);
        }
    }

    addFunctionToQueue(fn, queue) {
        if (typeof fn !== 'function') {
            throw new Error('Only functions can be added to the queue');
        }

        let wrapped = async () => {
            await fn.call(this);
        };
        Object.defineProperty(wrapped, 'name', {
            value: `${fn.name}`,
        });
        queue.push(wrapped);
    }

    addAction(fn) {
        if (typeof fn !== 'function') {
            throw new Error('Only functions can be added to the queue');
        }
        this.addFunctionToQueue(fn, this.cmdQueue);
    }

    addFinally(fn) {
        if (typeof fn !== 'function') {
            throw new Error('Only functions can be added to the finally queue');
        }
        this.addFunctionToQueue(fn, this.finallyQueue);
    }

    addActions() {
        if (this.options.debug) {
            this.addAction(this.printDebugInfo);
        }
        this.addAction(this.executeVersionCheck);
    }
}
