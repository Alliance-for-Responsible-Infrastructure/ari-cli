import { describe, expect, test } from '@jest/globals';
import {
    validateDataManifest,
    stageEntry,
    prefixFor,
    keyFor,
    assertSafeRunId,
    assertSafeId,
} from '#src/lib/cli/manifest.js';

import { MANIFEST } from '../helpers/manifest-fixture.js';

describe('validateDataManifest', () => {
    test('accepts a good schema-1 manifest', () => {
        expect(validateDataManifest(MANIFEST, 'dev-demo')).toBe(MANIFEST);
    });

    test('an unknown schema is a clear "update ari-cli" error', () => {
        expect(() =>
            validateDataManifest({ ...MANIFEST, schema: 2 }, 'dev-demo'),
        ).toThrow(/schema 2.*Update ari-cli/);
    });

    test.each([
        ['no bucketName', { bucketName: undefined }],
        ['another keyTemplate', { keyTemplate: '{runId}/{stage}/{id}' }],
        ['no classification', { classification: undefined }],
        ['no stages', { stages: [] }],
        ['stage id with a slash', { stages: [{ id: 'a/b', loadable: true, readable: true }] }],
        ['non-boolean readable', { stages: [{ id: 'raw', loadable: true, readable: 'yes' }] }],
        ['duplicate stages', { stages: [MANIFEST.stages[0], MANIFEST.stages[0]] }],
        ['unknown inputStage', { inputStage: 'nope' }],
        ['unknown resultKey stage', { resultKey: { stage: 'nope', id: 'x' } }],
        ['resultKey without id', { resultKey: { stage: 'final' } }],
        ['non-string accountKey', { accountKey: 5 }],
    ])('rejects %s', (_name, patch) => {
        expect(() =>
            validateDataManifest({ ...MANIFEST, ...patch }, 'dev-demo'),
        ).toThrow(/manifest for "dev-demo" is invalid/);
    });

    test('a manifest without accountKey is allowed (state machine ARN guard only)', () => {
        const { accountKey: _unused, ...rest } = MANIFEST;
        expect(() => validateDataManifest(rest, 'dev-demo')).not.toThrow();
    });
});

describe('keys', () => {
    test('prefixFor/keyFor follow {stage}/{runId}/{id}', () => {
        expect(prefixFor(MANIFEST, 'raw', 'r1')).toBe('raw/r1/');
        expect(keyFor(MANIFEST, 'chunks', 'r1', 'a.pdf/p1.txt')).toBe(
            'chunks/r1/a.pdf/p1.txt',
        );
    });

    test('unknown stage is a usage error (exit 2) that lists the stages', () => {
        expect(() => stageEntry(MANIFEST, 'bogus')).toThrow(/raw, chunks, final/);
        try {
            stageEntry(MANIFEST, 'bogus');
        } catch (e) {
            expect(e.exitCode).toBe(2);
        }
    });

    test.each(['', 'a/b', 'a\\b', '..', '.', 'x\ny'])(
        'rejects run id %j',
        (id) => {
            expect(() => assertSafeRunId(id)).toThrow(/Invalid run id/);
        },
    );

    test.each(['', '/abs', '../x', 'a/../b', 'a/./b', 'x\u0000y'])(
        'rejects object id %j',
        (id) => {
            expect(() => assertSafeId(id)).toThrow(/Invalid object id/);
        },
    );

    test('accepts ordinary ids, including spaces and nested paths', () => {
        expect(assertSafeId('Attachment 1.pdf/pages-0001-0004.txt')).toBe(
            'Attachment 1.pdf/pages-0001-0004.txt',
        );
    });
});
