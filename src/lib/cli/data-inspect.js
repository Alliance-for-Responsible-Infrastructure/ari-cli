/**
 * Structure-only inspection of an object's bytes for `ari pipeline data
 * inspect`. The bytes are read in this process but NOTHING derived from a
 * value is ever returned: only sizes, counts, column names (the CSV header)
 * and JSON key names with value TYPES. Parse failures yield fixed messages
 * (never the parser's own message, which can quote input text).
 *
 * Pure: no AWS, no filesystem, no terminal.
 */
import { isBinary, safeText } from '#src/lib/cli/content-gate.js';

/** Objects larger than this are described from metadata only (no read). */
export const INSPECT_MAX_BYTES = 64 * 1024 * 1024;

const MAX_COLUMNS_SHOWN = 100;
const MAX_KEYS_SHOWN = 50;
const MAX_DEPTH = 4;
const NAME_MAX = 64;

/** `csv` | `json` | `other`, from the object id's extension (a format, not a schema). */
export function detectKind(id) {
    const lower = String(id).toLowerCase();
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.json')) return 'json';
    return 'other';
}

/**
 * Header names, record count and column consistency of a CSV text. Quoted
 * fields (embedded commas, newlines, "" escapes) are handled. Only the header
 * record's text is retained.
 */
export function inspectCsv(input) {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    let header = null;
    let rows = 0;
    let ragged = 0;
    let inQuotes = false;
    let field = '';
    let fields = [];
    let fieldCount = 0;
    let recordSeen = false;

    const endField = () => {
        if (header === null) fields.push(field);
        fieldCount += 1;
        field = '';
    };
    const endRecord = () => {
        if (!recordSeen) return; // blank line
        endField();
        if (header === null) {
            header = fields;
        } else {
            rows += 1;
            if (fieldCount !== header.length) ragged += 1;
        }
        fields = [];
        fieldCount = 0;
        recordSeen = false;
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    if (header === null) field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else if (header === null) {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            recordSeen = true;
        } else if (ch === ',') {
            recordSeen = true;
            endField();
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            endRecord();
        } else {
            recordSeen = true;
            if (header === null) field += ch;
        }
    }
    const warnings = [];
    if (inQuotes) warnings.push('unterminated quoted field at end of file');
    endRecord();

    const columns = header ?? [];
    return {
        rows,
        columnCount: columns.length,
        columns: columns
            .slice(0, MAX_COLUMNS_SHOWN)
            .map((c) => (c.trim() === '' ? '(empty)' : safeText(c, NAME_MAX))),
        columnsOmitted: Math.max(0, columns.length - MAX_COLUMNS_SHOWN),
        raggedRows: ragged,
        warnings,
    };
}

/**
 * The key shape of a parsed JSON value: key names (sanitized) mapped to value
 * TYPES. Arrays are `array(n)` and are not descended into. Never returns a
 * string/number/boolean value.
 */
export function jsonShape(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') {
        if (depth >= MAX_DEPTH) return 'object';
        const keys = Object.keys(value);
        const shape = {};
        for (const key of keys.slice(0, MAX_KEYS_SHOWN)) {
            shape[safeText(key, NAME_MAX)] = jsonShape(value[key], depth + 1);
        }
        if (keys.length > MAX_KEYS_SHOWN) {
            shape['...'] = `+${keys.length - MAX_KEYS_SHOWN} more keys`;
        }
        return shape;
    }
    return typeof value; // string | number | boolean
}

/** `{"verdict": string, "rows": array(12)}` rendering of a jsonShape. */
export function renderShape(shape) {
    if (typeof shape === 'string') return shape;
    const parts = Object.entries(shape).map(
        ([k, v]) => `${JSON.stringify(k)}: ${renderShape(v)}`,
    );
    return `{${parts.join(', ')}}`;
}

/**
 * Builds the inspect result for one object.
 *
 * @param {Object} p
 * @param {string} p.id
 * @param {Object} p.head - { size, contentType, lastModified, versionId }
 * @param {Buffer|null} p.bytes - the object's bytes, or null if not read
 */
export function inspectContent({ id, head, bytes }) {
    const result = {
        kind: detectKind(id),
        bytes: head.size,
        contentType: head.contentType ?? null,
        lastModified: head.lastModified
            ? new Date(head.lastModified).toISOString()
            : null,
        versionId: head.versionId ?? null,
    };
    if (result.kind === 'other' || bytes === null || bytes === undefined) {
        return { ...result, parsed: false };
    }
    if (isBinary(bytes)) {
        return {
            ...result,
            parsed: false,
            note: 'binary content (NUL bytes); structure not inspected',
        };
    }

    if (result.kind === 'csv') {
        return { ...result, parsed: true, ...inspectCsv(bytes.toString('utf8')) };
    }

    let parsed;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
        // Deliberately NOT the parser's message: it can quote input text.
        return { ...result, parsed: false, note: 'not valid JSON' };
    }
    return { ...result, parsed: true, shape: jsonShape(parsed) };
}

/** Text lines for a result (the allow-list of what inspect prints). */
export function renderInspect(result, { key }) {
    const lines = [
        `Object:        ${safeText(key, 400)}`,
        `Size:          ${result.bytes} bytes`,
        `Type:          ${result.kind === 'other' ? (result.contentType ?? 'unknown') : result.kind.toUpperCase()}`,
        `Last modified: ${result.lastModified ?? '-'}`,
        `Version:       ${result.versionId ?? '-'}`,
    ];
    if (result.note) lines.push(`Note:          ${result.note}`);
    if (result.kind === 'csv' && result.parsed) {
        lines.push(
            `Rows:          ${result.rows} (excluding header)`,
            `Columns:       ${result.columnCount}`,
            `Header:        ${result.columns.join(', ')}${result.columnsOmitted ? `, ... (+${result.columnsOmitted} more)` : ''}`,
        );
        if (result.raggedRows > 0) {
            lines.push(
                `Ragged rows:   ${result.raggedRows} (field count differs from the header)`,
            );
        }
        for (const w of result.warnings) lines.push(`Warning:       ${w}`);
    }
    if (result.kind === 'json' && result.parsed) {
        lines.push(`Shape:         ${renderShape(result.shape)}`);
    }
    return lines;
}
