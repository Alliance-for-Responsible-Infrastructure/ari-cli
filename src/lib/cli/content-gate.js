/**
 * The content gate for `ari pipeline data get|cat` and `ari pipeline fetch`:
 * everything that decides whether protected object content may reach the
 * operator's terminal or disk, as small pure-ish functions so each rule is
 * unit-tested.
 *
 * Rules (spec "Decisions" 3-5, no bypass of any kind -- no env var, no config
 * setting, no flag other than the per-call --yes):
 *  1. only stages the manifest marks `readable: true`
 *  2. a banner (stderr) naming pipeline, account, bucket, key, size, version
 *  3. TTY: y/N confirm; non-TTY: --yes or exit 2
 *  4. `cat` is size-bounded (64 KiB default, 1 MiB hard cap); binary refused
 *  5. downloaded files are written 0600, never overwritten without --force
 *  6. content is only ever written to stdout (`cat`) or the --out file
 */
import nodeFs from 'fs';
import os from 'os';
import path from 'path';

import { stageEntry } from '#src/lib/cli/manifest.js';
import { EXIT, PipelineError } from '#src/lib/cli/pipeline-utils.js';

export const CAT_DEFAULT_BYTES = 64 * 1024;
export const CAT_HARD_CAP_BYTES = 1024 * 1024;
export const BINARY_SNIFF_BYTES = 4096;

/** Folders (under $HOME) that sync to a cloud service: warn when writing there. */
export const CLOUD_SYNC_DIRS = [
    'Dropbox',
    'Library/Mobile Documents',
    'Library/CloudStorage',
    'Google Drive',
    'OneDrive',
];

/** Refuses stages the manifest does not mark `readable`. Exit 2. */
export function assertReadableStage(manifest, stage, command) {
    const entry = stageEntry(manifest, stage);
    if (!entry.readable) {
        throw new PipelineError(
            `Stage "${stage}" is not readable through "${command}" (the pipeline's manifest marks it readable: false` +
                (entry.description ? `: ${safeText(entry.description, 80)}` : '') +
                '). Its contents stay in AWS.',
            EXIT.USAGE,
        );
    }
    return entry;
}

/** Parses `cat --max-bytes`: default 64 KiB, positive integer, hard cap 1 MiB. */
export function parseMaxBytes(value) {
    if (value === undefined || value === null) return CAT_DEFAULT_BYTES;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw new PipelineError(
            '--max-bytes must be a positive integer.',
            EXIT.USAGE,
        );
    }
    if (n > CAT_HARD_CAP_BYTES) {
        throw new PipelineError(
            `--max-bytes cannot exceed ${CAT_HARD_CAP_BYTES} (1 MiB). Use "ari pipeline data get" to download a whole object.`,
            EXIT.USAGE,
        );
    }
    return n;
}

/** Parses `cat --head <lines>`; undefined means "no line limit". */
export function parseHeadLines(value) {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw new PipelineError(
            '--head must be a positive integer.',
            EXIT.USAGE,
        );
    }
    return n;
}

/** NUL byte in the first 4 KiB => binary (refused). */
export function isBinary(buffer) {
    const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
    return sniff.includes(0);
}

/**
 * Makes manifest/listing-derived text safe to print: control characters
 * (including ESC, so no terminal escape sequences) become "?", and the text
 * is truncated.
 */
export function safeText(value, max = 200) {
    // eslint-disable-next-line no-control-regex
    const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
    return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export function formatBytes(bytes) {
    if (bytes === undefined || bytes === null) return '-';
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

/**
 * The banner lines (to stderr) shown before any content access. A manifest
 * classification other than "protected" still gets a banner (the gate never
 * relaxes); it just names the classification.
 */
export function buildBanner({
    action,
    name,
    classification,
    account,
    accountKey,
    bucket,
    key,
    size,
    versionId,
    callerArn,
}) {
    const label =
        classification === 'protected'
            ? 'PROTECTED DATA'
            : `${String(classification).toUpperCase()} DATA`;
    return [
        `${label} - ${action} reads object content from pipeline ${name}.`,
        `  account:  ${account}${accountKey ? ` (${accountKey})` : ''}`,
        `  bucket:   ${bucket}`,
        `  key:      ${safeText(key, 400)}`,
        `  size:     ${formatBytes(size)}`,
        `  version:  ${versionId ?? '-'}`,
        `This read is recorded in CloudTrail under ${callerArn}.`,
    ];
}

/**
 * Warnings (not refusals) for an output path: inside a git work tree, or
 * under a cloud-sync folder.
 */
export function pathWarnings(
    outPath,
    { homedir = os.homedir(), existsSync = nodeFs.existsSync } = {},
) {
    const warnings = [];
    const resolved = path.resolve(outPath);

    let dir = path.dirname(resolved);
    for (;;) {
        if (existsSync(path.join(dir, '.git'))) {
            warnings.push(
                `${resolved} is inside a git work tree (${dir}); do not commit it.`,
            );
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    const lower = resolved.toLowerCase();
    for (const rel of CLOUD_SYNC_DIRS) {
        const syncDir = path.join(homedir, rel).toLowerCase();
        if (lower === syncDir || lower.startsWith(syncDir + path.sep)) {
            warnings.push(
                `${resolved} is inside a cloud-sync folder (~/${rel}); the protected data would be copied off this machine.`,
            );
        }
    }
    return warnings;
}

/** Refuses to overwrite an existing path unless `force`. Exit 2. */
export function assertCanWrite(
    outPath,
    force,
    { existsSync = nodeFs.existsSync } = {},
) {
    if (!force && existsSync(outPath)) {
        throw new PipelineError(
            `${outPath} already exists; refusing to overwrite it. Choose another --out or pass --force.`,
            EXIT.USAGE,
        );
    }
}

/**
 * Step 3 of the gate, run BEFORE any S3 call so a refusal costs nothing:
 * without --yes a non-interactive session is refused (exit 2).
 */
export function assertCanConfirm({ yes, interactive }) {
    if (!yes && !interactive) {
        throw new PipelineError(
            'Refusing to read protected content without confirmation on a non-interactive terminal. Re-run with --yes.',
            EXIT.USAGE,
        );
    }
}

/**
 * Prints the banner and (unless --yes) asks y/N on the terminal.
 * @param {Object} p
 * @param {string[]} p.banner
 * @param {string[]} [p.warnings]
 * @param {boolean} p.yes
 * @param {(q: string) => Promise<boolean>} p.confirm
 * @param {(...a: any[]) => void} [p.logErr]
 */
export async function runGate({
    banner,
    warnings = [],
    yes,
    confirm,
    logErr = (...a) => console.error(...a),
    question = 'Continue?',
}) {
    for (const line of banner) logErr(line);
    for (const w of warnings) logErr(`Warning: ${w}`);
    if (yes) return;
    if (!(await confirm(question))) {
        throw new PipelineError('Not confirmed; nothing was read.', EXIT.USAGE);
    }
}

/**
 * Writes an async-iterable of byte chunks to `outPath` with mode 0600.
 * The first 4 KiB is buffered and sniffed for NUL bytes BEFORE the file is
 * created, so a binary object never touches disk. Without `force` an existing
 * file is never overwritten (exclusive create). A failed write removes the
 * partial file.
 *
 * @returns {Promise<{bytes: number}>}
 */
export async function writeProtectedFile(
    outPath,
    body,
    { force = false, fs = nodeFs } = {},
) {
    const iterator = body[Symbol.asyncIterator]();
    const head = [];
    let headLen = 0;
    let finished = false;
    while (headLen < BINARY_SNIFF_BYTES && !finished) {
        const { value, done } = await iterator.next();
        if (done) {
            finished = true;
        } else {
            const chunk = Buffer.from(value);
            head.push(chunk);
            headLen += chunk.length;
        }
    }
    if (isBinary(Buffer.concat(head))) {
        body.destroy?.();
        throw new PipelineError(
            'This object looks binary (NUL bytes in the first 4 KiB); refusing to download it.',
            EXIT.USAGE,
        );
    }

    let fd;
    try {
        fd = fs.openSync(outPath, force ? 'w' : 'wx', 0o600);
    } catch (e) {
        body.destroy?.();
        if (e.code === 'EEXIST') {
            throw new PipelineError(
                `${outPath} already exists; refusing to overwrite it. Choose another --out or pass --force.`,
                EXIT.USAGE,
            );
        }
        throw new PipelineError(`Cannot write ${outPath}: ${e.code ?? e.name}.`);
    }
    let bytes = 0;
    try {
        fs.fchmodSync(fd, 0o600); // an existing file (--force) keeps its old mode otherwise
        for (const chunk of head) {
            fs.writeSync(fd, chunk);
            bytes += chunk.length;
        }
        while (!finished) {
            const { value, done } = await iterator.next();
            if (done) break;
            const chunk = Buffer.from(value);
            fs.writeSync(fd, chunk);
            bytes += chunk.length;
        }
    } catch (e) {
        try {
            fs.closeSync(fd);
            fd = undefined;
            fs.unlinkSync(outPath);
        } catch {
            // best effort
        }
        throw e;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return { bytes };
}
