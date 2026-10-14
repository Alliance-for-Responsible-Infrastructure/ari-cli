import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { jest, describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import {
    CAT_DEFAULT_BYTES,
    CAT_HARD_CAP_BYTES,
    assertCanConfirm,
    assertCanWrite,
    assertReadableStage,
    buildBanner,
    isBinary,
    parseHeadLines,
    parseMaxBytes,
    pathWarnings,
    runGate,
    safeText,
    writeProtectedFile,
} from '#src/lib/cli/content-gate.js';
import { MANIFEST } from '../helpers/manifest-fixture.js';

describe('readable allow-list', () => {
    test('readable stages pass', () => {
        expect(assertReadableStage(MANIFEST, 'chunks', 'data cat').id).toBe('chunks');
    });

    test('readable:false stages are refused with exit 2 (no bypass)', () => {
        try {
            assertReadableStage(MANIFEST, 'raw', 'data cat');
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.message).toMatch(/Stage "raw" is not readable.*stay in AWS/s);
            expect(e.exitCode).toBe(2);
        }
    });

    test('unknown stages are refused', () => {
        expect(() => assertReadableStage(MANIFEST, 'nope', 'data cat')).toThrow(/Unknown stage/);
    });
});

describe('size caps', () => {
    test('default 64 KiB, hard cap 1 MiB', () => {
        expect(CAT_DEFAULT_BYTES).toBe(65536);
        expect(CAT_HARD_CAP_BYTES).toBe(1048576);
        expect(parseMaxBytes(undefined)).toBe(65536);
        expect(parseMaxBytes('100')).toBe(100);
        expect(parseMaxBytes('1048576')).toBe(1048576);
    });

    test.each(['1048577', '0', '-3', 'abc', '1.5'])('rejects --max-bytes %s with exit 2', (v) => {
        try {
            parseMaxBytes(v);
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.exitCode).toBe(2);
        }
    });

    test('--head', () => {
        expect(parseHeadLines(undefined)).toBeUndefined();
        expect(parseHeadLines('5')).toBe(5);
        expect(() => parseHeadLines('0')).toThrow(/positive integer/);
    });
});

describe('binary sniff', () => {
    test('NUL in the first 4 KiB is binary; later NULs are not sniffed', () => {
        expect(isBinary(Buffer.from('plain,text\n1,2\n'))).toBe(false);
        expect(isBinary(Buffer.from([0x25, 0x50, 0x00, 0x01]))).toBe(true);
        const late = Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0])]);
        expect(isBinary(late)).toBe(false);
    });
});

describe('safeText', () => {
    test('replaces control characters (no terminal escapes) and truncates', () => {
        expect(safeText('a\u001b[31mb\nc')).toBe('a?[31mb?c');
        expect(safeText('x'.repeat(10), 4)).toBe('xxxx...');
    });
});

describe('banner', () => {
    const base = {
        action: 'cat',
        name: 'dev-demo',
        account: '123456789012',
        accountKey: 'controlled',
        bucket: 'dev-demo-pipeline',
        key: 'final/r1/final.csv',
        size: 2048,
        versionId: 'v1',
        callerArn: 'arn:aws:sts::123456789012:assumed-role/Admin/jo',
    };

    test('protected classification: PROTECTED DATA banner with account, bucket, key, size, version, caller', () => {
        const text = buildBanner({ ...base, classification: 'protected' }).join('\n');
        expect(text).toMatch(/^PROTECTED DATA/);
        expect(text).toContain('123456789012 (controlled)');
        expect(text).toContain('dev-demo-pipeline');
        expect(text).toContain('final/r1/final.csv');
        expect(text).toContain('2.0 KiB');
        expect(text).toContain('v1');
        expect(text).toContain('recorded in CloudTrail under arn:aws:sts::123456789012:assumed-role/Admin/jo');
    });

    test('any other classification still gets a banner (the gate never relaxes)', () => {
        const text = buildBanner({ ...base, classification: 'internal' }).join('\n');
        expect(text).toMatch(/^INTERNAL DATA/);
    });
});

describe('confirmation', () => {
    test('non-interactive without --yes is refused (exit 2) before any S3 call', () => {
        try {
            assertCanConfirm({ yes: false, interactive: false });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.exitCode).toBe(2);
            expect(e.message).toMatch(/--yes/);
        }
        expect(() => assertCanConfirm({ yes: true, interactive: false })).not.toThrow();
        expect(() => assertCanConfirm({ yes: false, interactive: true })).not.toThrow();
    });

    test('runGate prints banner + warnings, then asks; "no" refuses', async () => {
        const logErr = jest.fn();
        const confirm = jest.fn().mockResolvedValue(false);
        await expect(
            runGate({ banner: ['B1', 'B2'], warnings: ['W'], yes: false, confirm, logErr }),
        ).rejects.toMatchObject({ exitCode: 2 });
        expect(logErr.mock.calls.map((c) => c[0])).toEqual(['B1', 'B2', 'Warning: W']);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    test('--yes skips the prompt but still prints the banner', async () => {
        const logErr = jest.fn();
        const confirm = jest.fn();
        await runGate({ banner: ['B'], yes: true, confirm, logErr });
        expect(confirm).not.toHaveBeenCalled();
        expect(logErr).toHaveBeenCalledWith('B');
    });
});

describe('path warnings', () => {
    test('warns inside a git work tree and under cloud-sync folders; clean paths are quiet', () => {
        const existsSync = (p) => p === '/home/u/proj/.git';
        expect(pathWarnings('/home/u/proj/sub/out.csv', { homedir: '/home/u', existsSync })).toEqual([
            expect.stringMatching(/inside a git work tree \(\/home\/u\/proj\)/),
        ]);
        expect(
            pathWarnings('/home/u/Dropbox/x/out.csv', { homedir: '/home/u', existsSync: () => false }),
        ).toEqual([expect.stringMatching(/cloud-sync folder \(~\/Dropbox\)/)]);
        expect(
            pathWarnings('/home/u/Library/Mobile Documents/com~apple~CloudDocs/o.csv', {
                homedir: '/home/u',
                existsSync: () => false,
            }),
        ).toHaveLength(1);
        expect(
            pathWarnings('/home/u/Downloads/o.csv', { homedir: '/home/u', existsSync: () => false }),
        ).toEqual([]);
    });
});

describe('file writes', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-gate-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const body = (...parts) => Readable.from(parts.map((p) => Buffer.from(p)));

    test('writes the bytes with mode 0600', async () => {
        const out = path.join(dir, 'out.csv');
        const { bytes } = await writeProtectedFile(out, body('a,b\n', '1,2\n'));
        expect(bytes).toBe(8);
        expect(fs.readFileSync(out, 'utf8')).toBe('a,b\n1,2\n');
        expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    });

    test('refuses to overwrite without force and leaves the file untouched', async () => {
        const out = path.join(dir, 'out.csv');
        fs.writeFileSync(out, 'KEEP');
        expect(() => assertCanWrite(out, false)).toThrow(/already exists/);
        await expect(writeProtectedFile(out, body('new'))).rejects.toThrow(/already exists/);
        expect(fs.readFileSync(out, 'utf8')).toBe('KEEP');
    });

    test('--force overwrites and tightens an existing file to 0600', async () => {
        const out = path.join(dir, 'out.csv');
        fs.writeFileSync(out, 'OLD-LONGER-CONTENT', { mode: 0o644 });
        fs.chmodSync(out, 0o644);
        expect(() => assertCanWrite(out, true)).not.toThrow();
        await writeProtectedFile(out, body('new'), { force: true });
        expect(fs.readFileSync(out, 'utf8')).toBe('new');
        expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    });

    test('a binary object is refused BEFORE the file is created', async () => {
        const out = path.join(dir, 'out.bin');
        await expect(
            writeProtectedFile(out, Readable.from([Buffer.from([0x25, 0x50, 0, 1, 2])])),
        ).rejects.toThrow(/binary/);
        expect(fs.existsSync(out)).toBe(false);
    });

    test('a stream error mid-write removes the partial file', async () => {
        const out = path.join(dir, 'out.csv');
        async function* broken() {
            yield Buffer.alloc(5000, 0x61);
            throw new Error('network');
        }
        await expect(writeProtectedFile(out, broken())).rejects.toThrow('network');
        expect(fs.existsSync(out)).toBe(false);
    });
});
