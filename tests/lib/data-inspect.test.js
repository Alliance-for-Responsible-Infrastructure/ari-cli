/**
 * `inspect` prints structure only. Every fixture below carries the sentinel
 * VALUE_SENTINEL_PROTECTED_TEXT in a value (never in a key/column name);
 * nothing the module returns or renders may contain it.
 */
import { describe, expect, test } from '@jest/globals';
import {
    detectKind,
    inspectCsv,
    inspectContent,
    jsonShape,
    renderInspect,
    renderShape,
} from '#src/lib/cli/data-inspect.js';

const S = 'VALUE_SENTINEL_PROTECTED_TEXT';
const head = { size: 100, contentType: 'text/csv', lastModified: new Date('2026-10-14T09:00:00Z'), versionId: 'v1' };
const everything = (result) =>
    JSON.stringify(result) + renderInspect(result, { key: 'final/r1/x' }).join('\n');

describe('detectKind', () => {
    test('by extension, case-insensitive', () => {
        expect(detectKind('a.pdf/pages.txt.csv')).toBe('csv');
        expect(detectKind('V.JSON')).toBe('json');
        expect(detectKind('a.pdf')).toBe('other');
    });
});

describe('inspectCsv', () => {
    test('header, column count, row count; values never appear', () => {
        const csv = `id,name,note\n1,${S},"has, comma ${S}"\n2,x,"multi\nline ${S}"\n`;
        const r = inspectCsv(csv);
        expect(r).toMatchObject({ rows: 2, columnCount: 3, columns: ['id', 'name', 'note'], raggedRows: 0 });
        expect(JSON.stringify(r)).not.toContain(S);
    });

    test('handles CRLF, BOM, blank lines and escaped quotes', () => {
        const r = inspectCsv(`\uFEFFa,"b ""q"""\r\n1,2\r\n\r\n3,4`);
        expect(r.columns).toEqual(['a', 'b "q"']);
        expect(r.rows).toBe(2);
    });

    test('counts ragged rows and flags an unterminated quote with a fixed message', () => {
        const r = inspectCsv(`a,b\n1\n2,3,${S}\n4,"${S}`);
        expect(r.raggedRows).toBe(2);
        expect(r.warnings).toEqual(['unterminated quoted field at end of file']);
        expect(JSON.stringify(r)).not.toContain(S);
    });

    test('empty input, and header-only input', () => {
        expect(inspectCsv('')).toMatchObject({ rows: 0, columnCount: 0 });
        expect(inspectCsv('a,b\n')).toMatchObject({ rows: 0, columnCount: 2 });
    });

    test('column names are sanitized and capped', () => {
        const wide = Array.from({ length: 150 }, (_, i) => `c${i}`).join(',');
        const r = inspectCsv(`${wide}\n`);
        expect(r.columns).toHaveLength(100);
        expect(r.columnsOmitted).toBe(50);
        expect(inspectCsv('a\u001b[2Jb,\n').columns).toEqual(['a?[2Jb', '(empty)']);
    });
});

describe('jsonShape', () => {
    test('keys with value types; arrays as array(n); no values', () => {
        const shape = jsonShape({
            verdict: S,
            n: 42,
            ok: true,
            none: null,
            rows: [S, S, S],
            nested: { a: S, deeper: { b: S } },
        });
        expect(shape).toEqual({
            verdict: 'string',
            n: 'number',
            ok: 'boolean',
            none: 'null',
            rows: 'array(3)',
            nested: { a: 'string', deeper: { b: 'string' } },
        });
        expect(renderShape(shape)).not.toContain(S);
        expect(renderShape({ verdict: 'string', rows: 'array(12)' })).toBe(
            '{"verdict": string, "rows": array(12)}',
        );
    });

    test('caps keys and depth', () => {
        const big = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 1]));
        expect(Object.keys(jsonShape(big))).toHaveLength(51);
        expect(jsonShape({ a: { b: { c: { d: { e: { f: S } } } } } })).toEqual({
            a: { b: { c: { d: 'object' } } },
        });
    });
});

describe('inspectContent', () => {
    test('csv: structure only, nothing derived from a value', () => {
        const bytes = Buffer.from(`col_a,col_b\n${S},${S}\n${S},${S}\n`);
        const r = inspectContent({ id: 'final.csv', head, bytes });
        expect(r).toMatchObject({ kind: 'csv', parsed: true, rows: 2, columnCount: 2, columns: ['col_a', 'col_b'] });
        expect(everything(r)).not.toContain(S);
        expect(everything(r)).toContain('col_a, col_b');
    });

    test('json: shape only', () => {
        const bytes = Buffer.from(JSON.stringify({ verdict: S, notes: S, rows: [S, S] }));
        const r = inspectContent({ id: 'v.json', head, bytes });
        expect(r.shape).toEqual({ verdict: 'string', notes: 'string', rows: 'array(2)' });
        expect(everything(r)).not.toContain(S);
        expect(renderInspect(r, { key: 'k' }).join('\n')).toContain(
            '{"verdict": string, "notes": string, "rows": array(2)}',
        );
    });

    test('invalid JSON: a fixed message, never the parser message (which quotes input)', () => {
        const bytes = Buffer.from(`{"verdict": ${S} oops}`);
        // sanity: the real parser message does quote input in modern Node
        let parserMessage = '';
        try { JSON.parse(bytes.toString()); } catch (e) { parserMessage = e.message; }
        expect(parserMessage.length).toBeGreaterThan(0);
        const r = inspectContent({ id: 'v.json', head, bytes });
        expect(r).toMatchObject({ parsed: false, note: 'not valid JSON' });
        expect(everything(r)).not.toContain(S);
    });

    test('binary bytes are not parsed', () => {
        const r = inspectContent({ id: 'x.csv', head, bytes: Buffer.from([0x61, 0x00, 0x62]) });
        expect(r.parsed).toBe(false);
        expect(r.note).toMatch(/binary/);
    });

    test('other formats (and unread objects): metadata only', () => {
        const r = inspectContent({ id: 'doc.pdf', head: { ...head, contentType: 'application/pdf' }, bytes: null });
        expect(r).toMatchObject({ kind: 'other', bytes: 100, contentType: 'application/pdf', versionId: 'v1', parsed: false });
        expect(renderInspect(r, { key: 'raw/r1/doc.pdf' }).join('\n')).toMatch(/Type:\s+application\/pdf/);
    });

    test('rendered csv block lists size, rows, columns, header', () => {
        const r = inspectContent({ id: 'f.csv', head, bytes: Buffer.from('a,b\n1,2\n') });
        const text = renderInspect(r, { key: 'final/r1/f.csv' }).join('\n');
        expect(text).toContain('Size:          100 bytes');
        expect(text).toContain('Rows:          1 (excluding header)');
        expect(text).toContain('Columns:       2');
        expect(text).toContain('Header:        a, b');
    });
});
