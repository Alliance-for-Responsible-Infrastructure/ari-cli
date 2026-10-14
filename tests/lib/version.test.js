import path from 'path';
import * as url from 'url';
import * as semver from 'semver';
import { describe, expect, test } from '@jest/globals';

import requireJSON from '#src/lib/require-json.js';
import { rawVersionString } from '#src/lib/program-utils.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkg = requireJSON(path.join(__dirname, '../..', 'package.json'));

/** First version that ships the `ari pipeline data` commands. Bump only when a newer feature becomes required. */
const MIN_FOR_PIPELINE_DATA = '0.2.0';

describe('package version', () => {
    test('is valid semver', () => {
        expect(semver.valid(pkg.version)).not.toBeNull();
    });

    test('is not the unbumped 0.1.0', () => {
        expect(pkg.version).not.toBe('0.1.0');
    });

    test(`is >= ${MIN_FOR_PIPELINE_DATA} (data commands)`, () => {
        expect(semver.gte(pkg.version, MIN_FOR_PIPELINE_DATA)).toBe(true);
    });

    test('--version source matches package.json', () => {
        expect(rawVersionString).toBe(pkg.version);
    });
});
