/**
 * Command classes for `ari pipeline data ...` and `ari pipeline fetch`:
 * sequencing, the content gate, and -- the point of this phase -- proof that
 * no protected value reaches stdout/stderr/debug output from the commands that
 * must not print content. AWS is mocked at the src/lib/cli/pipeline.js layer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { MANIFEST } from '../helpers/manifest-fixture.js';

const SENTINEL = 'VALUE_SENTINEL_PROTECTED_TEXT';

jest.unstable_mockModule('#src/lib/version-check.js', () => ({
    default: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('#src/lib/cli/prompt.js', () => ({
    isInteractive: jest.fn(() => true),
    confirm: jest.fn().mockResolvedValue(true),
}));
jest.unstable_mockModule('#src/lib/cli/pipeline.js', () => ({
    resolveDataPipeline: jest.fn(),
    listDataObjects: jest.fn(),
    dataPrefixHasObjects: jest.fn(),
    listLocalFiles: jest.fn(),
    uploadDataFiles: jest.fn(),
    headDataObject: jest.fn(),
    readDataObject: jest.fn(),
    downloadDataObject: jest.fn(),
}));

const lib = await import('#src/lib/cli/pipeline.js');
const { confirm, isInteractive } = await import('#src/lib/cli/prompt.js');
const {
    PipelineDataStagesCommand,
    PipelineDataLsCommand,
    PipelineDataLoadCommand,
    PipelineDataGetCommand,
    PipelineDataInspectCommand,
    PipelineDataCatCommand,
} = await import('#src/classes/pipeline-data.js');

const CALLER = 'arn:aws:sts::123456789012:assumed-role/Admin/jo';
const base = { name: 'dev-demo', region: 'us-east-1' };

let out; // everything the command printed, all channels
let stdoutBytes;
let tmp;

beforeEach(() => {
    jest.clearAllMocks();
    out = [];
    stdoutBytes = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => out.push(['log', a.join(' ')]));
    jest.spyOn(console, 'error').mockImplementation((...a) => out.push(['err', a.join(' ')]));
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutBytes.push(Buffer.from(chunk));
        return true;
    });
    isInteractive.mockReturnValue(true);
    confirm.mockResolvedValue(true);
    lib.resolveDataPipeline.mockResolvedValue({
        stateMachineArn: MANIFEST.stateMachineArn,
        account: '123456789012',
        callerArn: CALLER,
        region: 'us-east-1',
        manifest: MANIFEST,
        accountKey: 'controlled',
    });
    lib.headDataObject.mockResolvedValue({
        key: 'final/run1/final.csv',
        size: 20,
        versionId: 'v7',
        contentType: 'text/csv',
        lastModified: new Date('2026-10-14T09:00:00Z'),
    });
    lib.downloadDataObject.mockResolvedValue({ bytes: 20 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ari-cls-'));
});
afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (Cls, options) => new Cls({ ...base, ...options }).execute();
const printed = () => out.map(([, t]) => t).join('\n') + Buffer.concat(stdoutBytes).toString();
const stderr = () => out.filter(([k]) => k === 'err').map(([, t]) => t).join('\n');
const fail = async (promise) => {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error('expected rejection');
};

describe('data stages', () => {
    test('prints the manifest stages and makes no S3 call', async () => {
        await run(PipelineDataStagesCommand, {});
        const text = printed();
        expect(text).toMatch(/raw\/\{runId\}\/\s+yes\s+no\s+source documents/);
        expect(text).toMatch(/chunks\/\{runId\}\/\s+no\s+yes/);
        expect(text).toContain('Input stage: raw');
        expect(text).toContain('Result: final/{runId}/final.csv');
        expect(lib.listDataObjects).not.toHaveBeenCalled();
    });

    test('--json', async () => {
        await run(PipelineDataStagesCommand, { json: true });
        const parsed = JSON.parse(out[0][1]);
        expect(parsed.stages).toHaveLength(3);
        expect(parsed.classification).toBe('protected');
    });
});

describe('data ls', () => {
    test('no --stage: per-stage counts, no keys', async () => {
        lib.listDataObjects.mockImplementation(async (_m, stage) =>
            stage === 'raw' ? [{ id: 'SECRET_FILE_NAME.pdf', size: 1500 }] : [],
        );
        await run(PipelineDataLsCommand, { runId: 'run1' });
        expect(printed()).toMatch(/raw\s+1\s+1\.5 KiB/);
        expect(printed()).not.toContain('SECRET_FILE_NAME');
    });

    test('--stage lists ids/sizes/dates; --ids and --match pass through', async () => {
        lib.listDataObjects.mockResolvedValue([
            { id: 'a.pdf/p1.txt', key: 'chunks/run1/a.pdf/p1.txt', size: 10, lastModified: new Date('2026-10-14T09:00:00Z') },
        ]);
        await run(PipelineDataLsCommand, { runId: 'run1', stage: 'chunks', match: 'a.pdf' });
        expect(lib.listDataObjects).toHaveBeenCalledWith(MANIFEST, 'chunks', 'run1', { match: 'a.pdf' }, 'us-east-1');
        expect(printed()).toContain('a.pdf/p1.txt');
        expect(printed()).toMatch(/1 object\(s\), 10 B/);

        out.length = 0;
        await run(PipelineDataLsCommand, { runId: 'run1', stage: 'chunks', ids: true });
        expect(out[0][1]).toBe('a.pdf/p1.txt');
    });

    test('--ids/--match without --stage is a usage error (exit 2) before any AWS call', async () => {
        const e = await fail(run(PipelineDataLsCommand, { runId: 'run1', ids: true }));
        expect(e.exitCode).toBe(2);
        expect(lib.resolveDataPipeline).not.toHaveBeenCalled();
    });

    test('an empty stage is an error', async () => {
        lib.listDataObjects.mockResolvedValue([]);
        await expect(run(PipelineDataLsCommand, { runId: 'run1', stage: 'chunks' })).rejects.toThrow(/No objects under chunks\/run1\//);
    });
});

describe('data load', () => {
    beforeEach(() => {
        lib.listLocalFiles.mockReturnValue(['SENTINEL_FILE_NAME.pdf', 'b.pdf']);
        lib.dataPrefixHasObjects.mockResolvedValue(false);
        lib.uploadDataFiles.mockResolvedValue({ count: 2, bytes: 3000 });
    });

    test('uploads to the input stage by default and prints counts, not file names', async () => {
        await run(PipelineDataLoadCommand, { runId: 'run1', localDir: '/d' });
        expect(lib.uploadDataFiles).toHaveBeenCalledWith(
            MANIFEST,
            expect.objectContaining({ stage: 'raw', runId: 'run1', localDir: '/d', fileNames: ['SENTINEL_FILE_NAME.pdf', 'b.pdf'] }),
            'us-east-1',
        );
        expect(printed()).toMatch(/2 PutObject call\(s\), 2\.9 KiB/);
        expect(printed()).not.toContain('SENTINEL_FILE_NAME');
        expect(printed()).toContain('ari pipeline run dev-demo --run-id run1 --wait');
    });

    test('refuses a stage the manifest does not mark loadable (exit 2)', async () => {
        const e = await fail(run(PipelineDataLoadCommand, { runId: 'run1', localDir: '/d', stage: 'final' }));
        expect(e.exitCode).toBe(2);
        expect(e.message).toMatch(/not loadable/);
        expect(lib.uploadDataFiles).not.toHaveBeenCalled();
    });

    test('rejects run ids with "/" before any AWS call', async () => {
        const e = await fail(run(PipelineDataLoadCommand, { runId: 'a/b', localDir: '/d' }));
        expect(e.exitCode).toBe(2);
        expect(lib.resolveDataPipeline).not.toHaveBeenCalled();
    });

    test('a non-empty prefix: warns, then TTY confirm decides', async () => {
        lib.dataPrefixHasObjects.mockResolvedValue(true);
        confirm.mockResolvedValue(false);
        const e = await fail(run(PipelineDataLoadCommand, { runId: 'run1', localDir: '/d' }));
        expect(e.exitCode).toBe(2);
        expect(stderr()).toMatch(/already has objects/);
        expect(lib.uploadDataFiles).not.toHaveBeenCalled();
    });

    test('a non-empty prefix on a non-TTY needs --yes (exit 2), and --yes proceeds', async () => {
        lib.dataPrefixHasObjects.mockResolvedValue(true);
        isInteractive.mockReturnValue(false);
        const e = await fail(run(PipelineDataLoadCommand, { runId: 'run1', localDir: '/d' }));
        expect(e.exitCode).toBe(2);
        await run(PipelineDataLoadCommand, { runId: 'run1', localDir: '/d', yes: true });
        expect(lib.uploadDataFiles).toHaveBeenCalledTimes(1);
    });
});

describe('data get / fetch (content gate)', () => {
    const getOpts = (over = {}) => ({ runId: 'run1', out: path.join(tmp, 'out.csv'), ...over });

    test('fetch: downloads the manifest resultKey after banner + confirm, to a 0600-writing lib call', async () => {
        await run(PipelineDataGetCommand, getOpts({ fetch: true }));
        expect(lib.headDataObject).toHaveBeenCalledWith(MANIFEST, 'final', 'run1', 'final.csv', 'us-east-1');
        expect(lib.downloadDataObject).toHaveBeenCalledWith(
            MANIFEST, 'final', 'run1', 'final.csv', path.join(tmp, 'out.csv'),
            { versionId: 'v7', force: undefined }, 'us-east-1',
        );
        const err = stderr();
        expect(err).toMatch(/^PROTECTED DATA/);
        expect(err).toContain('123456789012 (controlled)');
        expect(err).toContain('final/run1/final.csv');
        expect(err).toContain('version:  v7');
        expect(err).toContain(`recorded in CloudTrail under ${CALLER}`);
        expect(err).toMatch(/protected data.*rm /s);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(printed()).toMatch(/Wrote 20 B to .*out\.csv \(mode 0600\)/);
    });

    test('default output path is ./<stage>-<runId><ext> for the result key', async () => {
        await run(PipelineDataGetCommand, { runId: 'run1', fetch: true });
        expect(lib.downloadDataObject.mock.calls[0][4]).toBe('./final-run1.csv');
    });

    test('get with an id needs --stage; an explicit id/stage is downloaded', async () => {
        const e = await fail(run(PipelineDataGetCommand, getOpts({ id: 'x.txt' })));
        expect(e.exitCode).toBe(2);
        lib.headDataObject.mockResolvedValue({ key: 'chunks/run1/a/b.txt', size: 5, versionId: undefined });
        await run(PipelineDataGetCommand, getOpts({ id: 'a/b.txt', stage: 'chunks' }));
        expect(lib.downloadDataObject.mock.calls[0].slice(1, 4)).toEqual(['chunks', 'run1', 'a/b.txt']);
    });

    test('get of a readable:false stage (raw) is refused with exit 2 and touches no S3 object', async () => {
        const e = await fail(run(PipelineDataGetCommand, getOpts({ id: 'doc.pdf', stage: 'raw' })));
        expect(e.exitCode).toBe(2);
        expect(e.message).toMatch(/not readable/);
        expect(lib.headDataObject).not.toHaveBeenCalled();
        expect(lib.downloadDataObject).not.toHaveBeenCalled();
    });

    test('non-TTY without --yes: exit 2 BEFORE any AWS call; with --yes it proceeds and still prints the banner', async () => {
        isInteractive.mockReturnValue(false);
        const e = await fail(run(PipelineDataGetCommand, getOpts({ fetch: true })));
        expect(e.exitCode).toBe(2);
        expect(lib.resolveDataPipeline).not.toHaveBeenCalled();

        await run(PipelineDataGetCommand, getOpts({ fetch: true, yes: true }));
        expect(confirm).not.toHaveBeenCalled();
        expect(stderr()).toMatch(/PROTECTED DATA/);
        expect(lib.downloadDataObject).toHaveBeenCalledTimes(1);
    });

    test('declining the TTY confirm downloads nothing', async () => {
        confirm.mockResolvedValue(false);
        const e = await fail(run(PipelineDataGetCommand, getOpts({ fetch: true })));
        expect(e.exitCode).toBe(2);
        expect(lib.downloadDataObject).not.toHaveBeenCalled();
    });

    test('refuses to overwrite an existing --out without --force, before the HEAD; --force passes through', async () => {
        const outPath = path.join(tmp, 'exists.csv');
        fs.writeFileSync(outPath, 'KEEP');
        const e = await fail(run(PipelineDataGetCommand, getOpts({ fetch: true, out: outPath })));
        expect(e.exitCode).toBe(2);
        expect(lib.headDataObject).not.toHaveBeenCalled();
        await run(PipelineDataGetCommand, getOpts({ fetch: true, out: outPath, force: true }));
        expect(lib.downloadDataObject.mock.calls[0][5]).toMatchObject({ force: true });
    });

    test('warns when the output path is inside a git work tree', async () => {
        fs.mkdirSync(path.join(tmp, '.git'));
        await run(PipelineDataGetCommand, getOpts({ fetch: true }));
        expect(stderr()).toMatch(/Warning: .*inside a git work tree/);
    });

    test('a non-protected classification still shows a banner and confirm (gate never relaxes)', async () => {
        lib.resolveDataPipeline.mockResolvedValue({
            ...(await lib.resolveDataPipeline()),
            manifest: { ...MANIFEST, classification: 'internal' },
        });
        await run(PipelineDataGetCommand, getOpts({ fetch: true }));
        expect(stderr()).toMatch(/^INTERNAL DATA/);
        expect(confirm).toHaveBeenCalled();
    });

    test('never prints object content (the lib returns only a byte count)', async () => {
        await run(PipelineDataGetCommand, getOpts({ fetch: true, debug: true }));
        expect(printed()).not.toContain(SENTINEL);
    });
});

describe('data cat (content gate)', () => {
    const catOpts = (over = {}) => ({ runId: 'run1', id: 'a.txt', stage: 'chunks', ...over });
    beforeEach(() => {
        lib.headDataObject.mockResolvedValue({ key: 'chunks/run1/a.txt', size: 11, versionId: 'v1' });
        lib.readDataObject.mockResolvedValue(Buffer.from('line1\nline2\n'));
    });

    test('prints the bytes to stdout only, after banner and confirm, with a ranged bounded read', async () => {
        await run(PipelineDataCatCommand, catOpts());
        expect(Buffer.concat(stdoutBytes).toString()).toBe('line1\nline2\n');
        expect(lib.readDataObject).toHaveBeenCalledWith(MANIFEST, 'chunks', 'run1', 'a.txt', { versionId: 'v1', maxBytes: 65536 }, 'us-east-1');
        expect(stderr()).toMatch(/PROTECTED DATA/);
        expect(out.filter(([k]) => k === 'log')).toEqual([]); // content is not routed via console.log
    });

    test('--max-bytes is honoured up to the 1 MiB hard cap; above it exits 2 before any AWS call', async () => {
        await run(PipelineDataCatCommand, catOpts({ maxBytes: '1048576' }));
        expect(lib.readDataObject.mock.calls[0][4].maxBytes).toBe(1048576);
        lib.resolveDataPipeline.mockClear();
        const e = await fail(run(PipelineDataCatCommand, catOpts({ maxBytes: '1048577' })));
        expect(e.exitCode).toBe(2);
        expect(lib.resolveDataPipeline).not.toHaveBeenCalled();
    });

    test('says how much was truncated and points to get', async () => {
        lib.headDataObject.mockResolvedValue({ key: 'chunks/run1/a.txt', size: 500000, versionId: 'v1' });
        lib.readDataObject.mockResolvedValue(Buffer.from('abc'));
        await run(PipelineDataCatCommand, catOpts({ maxBytes: '3' }));
        expect(stderr()).toMatch(/first 3 of 500000 bytes.*ari pipeline data get dev-demo run1 "a\.txt" --stage chunks/s);
    });

    test('--head limits lines', async () => {
        await run(PipelineDataCatCommand, catOpts({ head: '1' }));
        expect(Buffer.concat(stdoutBytes).toString()).toBe('line1\n');
        expect(stderr()).toMatch(/first 1 line/);
    });

    test('binary content is refused and nothing is written to stdout', async () => {
        lib.readDataObject.mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x00, 0x46]));
        const e = await fail(run(PipelineDataCatCommand, catOpts()));
        expect(e.exitCode).toBe(2);
        expect(e.message).toMatch(/binary/);
        expect(stdoutBytes).toEqual([]);
    });

    test('readable:false stage (raw) refused with exit 2; no S3 call at all', async () => {
        const e = await fail(run(PipelineDataCatCommand, catOpts({ stage: 'raw' })));
        expect(e.exitCode).toBe(2);
        expect(lib.headDataObject).not.toHaveBeenCalled();
        expect(lib.readDataObject).not.toHaveBeenCalled();
    });

    test('non-TTY without --yes: exit 2 before any AWS call; declined confirm: nothing read', async () => {
        isInteractive.mockReturnValue(false);
        const e = await fail(run(PipelineDataCatCommand, catOpts()));
        expect(e.exitCode).toBe(2);
        expect(lib.resolveDataPipeline).not.toHaveBeenCalled();

        isInteractive.mockReturnValue(true);
        confirm.mockResolvedValue(false);
        await fail(run(PipelineDataCatCommand, catOpts()));
        expect(lib.readDataObject).not.toHaveBeenCalled();
        expect(stdoutBytes).toEqual([]);
    });

    test('an empty object prints a notice and reads nothing', async () => {
        lib.headDataObject.mockResolvedValue({ key: 'chunks/run1/a.txt', size: 0 });
        await run(PipelineDataCatCommand, catOpts());
        expect(lib.readDataObject).not.toHaveBeenCalled();
    });
});

describe('data inspect (structure only)', () => {
    const inspectOpts = (over = {}) => ({ runId: 'run1', id: 'final.csv', stage: 'final', ...over });
    const head = (over = {}) => ({
        key: 'final/run1/final.csv', size: 60, versionId: 'v3', contentType: 'text/csv',
        lastModified: new Date('2026-10-14T09:00:00Z'), ...over,
    });

    test('CSV: prints header/rows/columns and NEVER a value (stdout, stderr, json, debug)', async () => {
        lib.headDataObject.mockResolvedValue(head());
        lib.readDataObject.mockResolvedValue(
            Buffer.from(`col_a,col_b\n${SENTINEL},"${SENTINEL}, with comma"\nrow2 ${SENTINEL},x\n`),
        );
        await run(PipelineDataInspectCommand, inspectOpts());
        let text = printed();
        expect(text).toContain('Rows:          2 (excluding header)');
        expect(text).toContain('Columns:       2');
        expect(text).toContain('Header:        col_a, col_b');
        expect(text).toContain('Version:       v3');
        expect(text).not.toContain(SENTINEL);

        out.length = 0;
        await run(PipelineDataInspectCommand, inspectOpts({ json: true, debug: true }));
        text = printed();
        expect(JSON.parse(out.find(([k, t]) => k === 'log' && t.includes('"kind"'))[1])).toMatchObject({
            kind: 'csv', rows: 2, columnCount: 2, columns: ['col_a', 'col_b'],
        });
        expect(text).not.toContain(SENTINEL);
        expect(stdoutBytes).toEqual([]);
    });

    test('JSON: key shape with types only; invalid JSON gives a fixed note', async () => {
        lib.headDataObject.mockResolvedValue(head({ key: 'chunks/run1/v.json' }));
        lib.readDataObject.mockResolvedValue(
            Buffer.from(JSON.stringify({ verdict: SENTINEL, notes: SENTINEL, rows: [SENTINEL, SENTINEL] })),
        );
        await run(PipelineDataInspectCommand, inspectOpts({ id: 'v.json', stage: 'chunks' }));
        expect(printed()).toContain('{"verdict": string, "notes": string, "rows": array(2)}');
        expect(printed()).not.toContain(SENTINEL);

        out.length = 0;
        lib.readDataObject.mockResolvedValue(Buffer.from(`{"verdict": ${SENTINEL} oops`));
        await run(PipelineDataInspectCommand, inspectOpts({ id: 'v.json', stage: 'chunks' }));
        expect(printed()).toContain('not valid JSON');
        expect(printed()).not.toContain(SENTINEL);
    });

    test('other formats: metadata only, and the object is not even read', async () => {
        lib.headDataObject.mockResolvedValue(head({ key: 'raw/run1/doc.pdf', contentType: 'application/pdf' }));
        await run(PipelineDataInspectCommand, inspectOpts({ id: 'doc.pdf', stage: 'raw' }));
        expect(lib.readDataObject).not.toHaveBeenCalled();
        expect(printed()).toMatch(/Type:\s+application\/pdf/);
    });

    test('binary bytes behind a .csv name: not parsed, nothing printed from them', async () => {
        lib.headDataObject.mockResolvedValue(head());
        lib.readDataObject.mockResolvedValue(Buffer.from(`a,b\n${SENTINEL}\u0000,x\n`));
        await run(PipelineDataInspectCommand, inspectOpts());
        expect(printed()).toContain('binary content');
        expect(printed()).not.toContain(SENTINEL);
    });

    test('very large structured objects are not read', async () => {
        lib.headDataObject.mockResolvedValue(head({ size: 200 * 1024 * 1024 }));
        await run(PipelineDataInspectCommand, inspectOpts());
        expect(lib.readDataObject).not.toHaveBeenCalled();
        expect(printed()).toMatch(/larger than 64\.0 MiB/);
    });

    test('is not gated by a prompt (nothing readable is printed) but states it reads and is audited', async () => {
        isInteractive.mockReturnValue(false);
        lib.headDataObject.mockResolvedValue(head());
        lib.readDataObject.mockResolvedValue(Buffer.from('a\n1\n'));
        await run(PipelineDataInspectCommand, inspectOpts());
        expect(confirm).not.toHaveBeenCalled();
        expect(stderr()).toMatch(/CloudTrail/);
    });
});
