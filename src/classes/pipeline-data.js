/**
 * `ari pipeline data stages|ls|load|get|inspect|cat` and `ari pipeline fetch`
 * -- the data plane. Everything here is driven by the pipeline's manifest
 * (see src/lib/cli/manifest.js); ari-cli knows the `{stage}/{runId}/{id}` key
 * shape and nothing about what any pipeline's stages contain.
 *
 * Protected-data rules (spec "Security and protected-data considerations"):
 *  - `stages`, `ls`, `load` never print object content.
 *  - `inspect` reads bytes in-process but prints structure only.
 *  - `get`, `cat`, `fetch` go through the content gate (src/lib/cli/content-gate.js):
 *    readable-stage allow-list, banner, TTY confirm or --yes (exit 2
 *    otherwise), size cap for `cat`, binary refused, 0600 files. There is no
 *    bypass. Content is written only to stdout (`cat`) or the --out file.
 *  - Nothing here logs content; the only record is CloudTrail.
 */
import path from 'path';
import { styles } from '#src/lib/cli/terminal.js';
import {
    resolveDataPipeline,
    listDataObjects,
    dataPrefixHasObjects,
    listLocalFiles,
    uploadDataFiles,
    headDataObject,
    readDataObject,
    downloadDataObject,
} from '#src/lib/cli/pipeline.js';
import { EXIT, PipelineError } from '#src/lib/cli/pipeline-utils.js';
import {
    assertSafeId,
    assertSafeRunId,
    prefixFor,
    stageEntry,
} from '#src/lib/cli/manifest.js';
import {
    assertCanConfirm,
    assertCanWrite,
    assertReadableStage,
    buildBanner,
    formatBytes,
    isBinary,
    parseHeadLines,
    parseMaxBytes,
    pathWarnings,
    runGate,
    safeText,
} from '#src/lib/cli/content-gate.js';
import {
    INSPECT_MAX_BYTES,
    detectKind,
    inspectContent,
    renderInspect,
} from '#src/lib/cli/data-inspect.js';
import { confirm, isInteractive } from '#src/lib/cli/prompt.js';
import BaseAriCommand from './base-command.js';

const { success, warn, emphasis, bold } = styles;

const pad = (value, width) => String(value ?? '').padEnd(width);

const isoDate = (d) =>
    d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '-';

/** Base for the data commands: stores the common options. */
class PipelineDataCommand extends BaseAriCommand {
    constructor(options) {
        super(options);
        this.name = options.name;
        this.runId = options.runId;
        this.region = options.region;
        this.exitCode = 0;
    }

    resolve() {
        return resolveDataPipeline(this.name, this.region);
    }
}

/** `ari pipeline data stages <name>` -- the manifest's stages. */
export class PipelineDataStagesCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.addActions();
    }

    async executeStages() {
        const { manifest, accountKey } = await this.resolve();
        const stages = manifest.stages.map((s) => ({
            id: s.id,
            prefix: `${s.id}/{runId}/`,
            loadable: s.loadable,
            readable: s.readable,
            description: s.description ?? '',
        }));
        if (this.options.json) {
            console.log(
                JSON.stringify({
                    name: this.name,
                    classification: manifest.classification,
                    accountKey: accountKey ?? null,
                    bucketName: manifest.bucketName,
                    inputStage: manifest.inputStage,
                    resultKey: manifest.resultKey,
                    stages,
                }),
            );
            return;
        }
        console.log(
            bold(this.name),
            `(classification: ${safeText(manifest.classification, 40)}${accountKey ? `, account: ${safeText(accountKey, 40)}` : ''})`,
        );
        const idW = Math.max(5, ...stages.map((s) => s.id.length)) + 2;
        const prefW = Math.max(6, ...stages.map((s) => s.prefix.length)) + 2;
        console.log(
            bold(
                `${pad('STAGE', idW)}${pad('PREFIX', prefW)}${pad('LOADABLE', 10)}${pad('READABLE', 10)}DESCRIPTION`,
            ),
        );
        for (const s of stages) {
            console.log(
                `${pad(safeText(s.id, 60), idW)}${pad(s.prefix, prefW)}${pad(s.loadable ? 'yes' : 'no', 10)}${pad(s.readable ? 'yes' : 'no', 10)}${safeText(s.description, 120)}`,
            );
        }
        console.log(
            `Input stage: ${manifest.inputStage}   Result: ${manifest.resultKey.stage}/{runId}/${safeText(manifest.resultKey.id, 120)}`,
        );
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeStages);
    }
}

/**
 * `ari pipeline data ls <name> <runId>` -- keys, sizes, dates. Not gated
 * (listing keys needs only s3:ListBucket). Without --stage: a per-stage
 * summary (counts and bytes, no keys).
 */
export class PipelineDataLsCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.addActions();
    }

    async executeLs() {
        const { stage, match, ids, json } = this.options;
        if (!stage && (ids || match)) {
            throw new PipelineError(
                '--ids and --match need --stage.',
                EXIT.USAGE,
            );
        }
        assertSafeRunId(this.runId);
        const { manifest } = await this.resolve();

        if (!stage) {
            const summary = [];
            for (const s of manifest.stages) {
                const objects = await listDataObjects(
                    manifest,
                    s.id,
                    this.runId,
                    {},
                    this.region,
                );
                summary.push({
                    stage: s.id,
                    objects: objects.length,
                    bytes: objects.reduce((sum, o) => sum + o.size, 0),
                });
            }
            if (json) {
                console.log(JSON.stringify(summary));
                return;
            }
            console.log(bold(`${pad('STAGE', 14)}${pad('OBJECTS', 10)}SIZE`));
            for (const row of summary) {
                console.log(
                    `${pad(safeText(row.stage, 12), 14)}${pad(row.objects, 10)}${formatBytes(row.bytes)}`,
                );
            }
            console.log(
                `Use --stage <stage> to list a stage's keys (${manifest.stages.map((s) => s.id).join(', ')}).`,
            );
            return;
        }

        stageEntry(manifest, stage);
        const objects = await listDataObjects(
            manifest,
            stage,
            this.runId,
            { match },
            this.region,
        );
        if (objects.length === 0) {
            throw new PipelineError(
                `No objects under ${prefixFor(manifest, stage, this.runId)}${match ? ` matching "${safeText(match, 80)}"` : ''}.`,
            );
        }
        if (json) {
            console.log(
                JSON.stringify(
                    objects.map((o) => ({
                        id: o.id,
                        key: o.key,
                        size: o.size,
                        lastModified: o.lastModified
                            ? new Date(o.lastModified).toISOString()
                            : null,
                    })),
                ),
            );
        } else if (ids) {
            console.log(objects.map((o) => safeText(o.id, 1024)).join('\n'));
        } else {
            for (const o of objects) {
                console.log(
                    `${formatBytes(o.size).padStart(10)}  ${isoDate(o.lastModified)}  ${safeText(o.id, 1024)}`,
                );
            }
            const total = objects.reduce((sum, o) => sum + o.size, 0);
            console.log(
                `\n${objects.length} object(s), ${formatBytes(total)}`,
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeLs);
    }
}

/**
 * `ari pipeline data load <name> <localDir> --run-id <id>` -- uploads the
 * top-level files of a local directory. Only `loadable` stages. Prints
 * counts, not file names (unless --debug).
 */
export class PipelineDataLoadCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.localDir = options.localDir;
        this.addActions();
    }

    async executeLoad() {
        const runId = assertSafeRunId(this.runId);
        const { manifest } = await this.resolve();
        const stage = this.options.stage ?? manifest.inputStage;
        if (!stageEntry(manifest, stage).loadable) {
            throw new PipelineError(
                `Stage "${stage}" is not loadable (the manifest marks it loadable: false). Loadable stages: ${manifest.stages
                    .filter((s) => s.loadable)
                    .map((s) => s.id)
                    .join(', ')}.`,
                EXIT.USAGE,
            );
        }
        const fileNames = listLocalFiles(this.localDir);
        const prefix = prefixFor(manifest, stage, runId);

        if (
            await dataPrefixHasObjects(
                manifest,
                stage,
                runId,
                this.region,
            )
        ) {
            console.error(
                warn('Warning:'),
                `s3://${manifest.bucketName}/${prefix} already has objects; uploading will add to (and may overwrite keys in) it.`,
            );
            if (!this.options.yes) {
                if (!isInteractive()) {
                    throw new PipelineError(
                        'Refusing to load into a non-empty prefix without confirmation on a non-interactive terminal. Re-run with --yes.',
                        EXIT.USAGE,
                    );
                }
                if (!(await confirm('Continue?'))) {
                    throw new PipelineError('Not loaded.', EXIT.USAGE);
                }
            }
        }

        console.log(
            `Uploading ${fileNames.length} file(s) from ${this.localDir} to s3://${manifest.bucketName}/${prefix}`,
        );
        const { count, bytes } = await uploadDataFiles(
            manifest,
            {
                stage,
                runId,
                localDir: this.localDir,
                fileNames,
                onFile: (n) =>
                    this.options.debug && console.log(`  uploaded ${n}`),
            },
            this.region,
        );
        console.log(
            success('Done:'),
            `${count} PutObject call(s), ${formatBytes(bytes)} total.`,
        );
        if (stage === manifest.inputStage) {
            console.log(
                `Run with: ${emphasis(`ari pipeline run ${this.name} --run-id ${runId} --wait`)}`,
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeLoad);
    }
}

/**
 * Shared front half of get/fetch/cat: validates flags, resolves the pipeline,
 * applies the readable-stage allow-list, HEADs the object (size/version for
 * the banner). Everything before the HEAD that can refuse does so WITHOUT any
 * S3 call.
 */
async function prepareGatedRead(cmd, { command, pickTarget, yes }) {
    assertCanConfirm({ yes, interactive: isInteractive() });
    assertSafeRunId(cmd.runId);
    const resolved = await cmd.resolve();
    const { manifest } = resolved;
    const target = pickTarget(manifest);
    assertReadableStage(manifest, target.stage, command);
    assertSafeId(target.id);
    return { resolved, target };
}

async function headAndGate(
    cmd,
    { resolved, target, action, yes, warnings = [] },
) {
    const { manifest, account, accountKey, callerArn } = resolved;
    const head = await headDataObject(
        manifest,
        target.stage,
        cmd.runId,
        target.id,
        cmd.region,
    );
    await runGate({
        banner: buildBanner({
            action,
            name: cmd.name,
            classification: manifest.classification,
            account,
            accountKey,
            bucket: manifest.bucketName,
            key: head.key,
            size: head.size,
            versionId: head.versionId,
            callerArn,
        }),
        warnings,
        yes,
        confirm,
        question: 'Read this object?',
    });
    return head;
}

/**
 * `ari pipeline data get <name> <runId> [<id>]` and `ari pipeline fetch
 * <name> <runId>` (`options.fetch`): download one object through the content
 * gate. With no id (or for `fetch`) the manifest's `resultKey` is used.
 */
export class PipelineDataGetCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.id = options.id;
        this.addActions();
    }

    #target(manifest) {
        const { stage } = this.options;
        if (this.options.fetch || this.id === undefined) {
            if (stage && stage !== manifest.resultKey.stage) {
                throw new PipelineError(
                    `Without an <id>, "get" downloads the result key (stage "${manifest.resultKey.stage}"); drop --stage or pass an <id>.`,
                    EXIT.USAGE,
                );
            }
            return { ...manifest.resultKey, isResult: true };
        }
        if (!stage) {
            throw new PipelineError(
                '--stage is required when an <id> is given.',
                EXIT.USAGE,
            );
        }
        return { stage, id: this.id, isResult: false };
    }

    #defaultOut(target) {
        const ext = path.extname(target.id);
        if (target.isResult) return `./${target.stage}-${this.runId}${ext}`;
        // eslint-disable-next-line no-control-regex
        const flat = target.id.replace(/[/\\\u0000-\u001f]/g, '_');
        return `./${target.stage}-${this.runId}-${flat}`;
    }

    async executeGet() {
        const { yes, force } = this.options;
        const command = this.options.fetch ? 'fetch' : 'data get';
        const { resolved, target } = await prepareGatedRead(this, {
            command,
            pickTarget: (m) => this.#target(m),
            yes,
        });
        const outPath = this.options.out ?? this.#defaultOut(target);
        assertCanWrite(outPath, force);

        const head = await headAndGate(this, {
            resolved,
            target,
            action: command,
            yes,
            warnings: pathWarnings(outPath),
        });

        const { bytes } = await downloadDataObject(
            resolved.manifest,
            target.stage,
            this.runId,
            target.id,
            outPath,
            { versionId: head.versionId, force },
            this.region,
        );
        console.log(
            success('Wrote'),
            `${formatBytes(bytes)} to ${outPath} (mode 0600)`,
        );
        console.error(
            warn('Reminder:'),
            `${outPath} is protected data. Keep it off shared or synced folders, and delete it when you are done: rm ${JSON.stringify(outPath)}`,
        );
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeGet);
    }
}

/**
 * `ari pipeline data cat <name> <runId> <id> --stage <stage>` -- bounded
 * print to stdout through the content gate.
 */
export class PipelineDataCatCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.id = options.id;
        this.addActions();
    }

    async executeCat() {
        const { yes, stage } = this.options;
        const maxBytes = parseMaxBytes(this.options.maxBytes);
        const headLines = parseHeadLines(this.options.head);
        const { resolved, target } = await prepareGatedRead(this, {
            command: 'data cat',
            pickTarget: () => ({ stage, id: this.id }),
            yes,
        });

        const head = await headAndGate(this, {
            resolved,
            target,
            action: 'cat',
            yes,
        });
        if (head.size === 0) {
            console.error('(empty object)');
            return;
        }

        const bytes = await readDataObject(
            resolved.manifest,
            target.stage,
            this.runId,
            target.id,
            { versionId: head.versionId, maxBytes },
            this.region,
        );
        if (isBinary(bytes)) {
            throw new PipelineError(
                'This object looks binary (NUL bytes in the first 4 KiB); refusing to print it.',
                EXIT.USAGE,
            );
        }

        let out = bytes;
        let shownLines = false;
        if (headLines !== undefined) {
            let idx = -1;
            for (let i = 0; i < headLines; i++) {
                idx = out.indexOf(0x0a, idx + 1);
                if (idx === -1) break;
            }
            if (idx !== -1 && idx + 1 < out.length) {
                out = out.subarray(0, idx + 1);
                shownLines = true;
            }
        }
        process.stdout.write(out);
        if (out.length > 0 && out[out.length - 1] !== 0x0a) {
            process.stdout.write('\n');
        }

        if (shownLines) {
            console.error(
                warn('Note:'),
                `showing the first ${headLines} line(s) only.`,
            );
        }
        if (head.size > bytes.length) {
            console.error(
                warn('Truncated:'),
                `printed the first ${bytes.length} of ${head.size} bytes. Download the rest with: ari pipeline data get ${this.name} ${this.runId} ${JSON.stringify(target.id)} --stage ${target.stage}`,
            );
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeCat);
    }
}

/**
 * `ari pipeline data inspect <name> <runId> <id> --stage <stage>` -- structure
 * only. Not content-gated because nothing readable reaches the terminal or
 * disk, but it does read the object in this process (a GetObject, recorded in
 * CloudTrail), so it needs the same IAM permission and account guard.
 */
export class PipelineDataInspectCommand extends PipelineDataCommand {
    constructor(options) {
        super(options);
        this.id = options.id;
        this.addActions();
    }

    async executeInspect() {
        const { stage, json } = this.options;
        assertSafeRunId(this.runId);
        assertSafeId(this.id);
        const { manifest } = await this.resolve();
        stageEntry(manifest, stage);

        const head = await headDataObject(
            manifest,
            stage,
            this.runId,
            this.id,
            this.region,
        );
        const kind = detectKind(this.id);
        let bytes = null;
        let note;
        if (kind !== 'other') {
            if (head.size > INSPECT_MAX_BYTES) {
                note = `larger than ${formatBytes(INSPECT_MAX_BYTES)}; structure not inspected`;
            } else if (head.size > 0) {
                bytes = await readDataObject(
                    manifest,
                    stage,
                    this.runId,
                    this.id,
                    { versionId: head.versionId },
                    this.region,
                );
            } else {
                note = 'empty object';
            }
        }
        const result = inspectContent({ id: this.id, head, bytes });
        if (note) result.note = note;

        console.error(
            'inspect reads the object in this process and prints structure only (no values). The read is recorded in CloudTrail.',
        );
        if (json) {
            console.log(JSON.stringify({ key: head.key, ...result }));
            return;
        }
        for (const line of renderInspect(result, { key: head.key })) {
            console.log(line);
        }
    }

    addActions() {
        super.addActions();
        this.addAction(this.executeInspect);
    }
}
