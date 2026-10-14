/**
 * Pure helpers for the pipeline operator manifest (schema 1, written by
 * ari-iac's PipelineRegistry to `/ari/pipelines/<name>/manifest`): validation
 * and the `{stage}/{runId}/{id}` key convention. Nothing here touches AWS or
 * the filesystem.
 */
import { EXIT, PipelineError } from '#src/lib/cli/pipeline-utils.js';

export const KEY_TEMPLATE = '{stage}/{runId}/{id}';

const isString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Validates the parts of a schema-1 manifest the data-plane commands rely on
 * and returns it. Fails closed: anything unexpected is an error, never a
 * guess.
 *
 * @param {Object} manifest
 * @param {string} name - the pipeline name (for messages)
 * @returns {Object} the same manifest
 */
export function validateDataManifest(manifest, name) {
    const bad = (what) =>
        new PipelineError(
            `The manifest for "${name}" is invalid (${what}); redeploy the pipeline with a current ari-iac.`,
        );

    if (manifest?.schema !== 1) {
        throw new PipelineError(
            `The manifest for "${name}" has schema ${JSON.stringify(manifest?.schema)}, but this ari-cli only understands schema 1. Update ari-cli.`,
        );
    }
    if (!isString(manifest.bucketName)) throw bad('bucketName');
    if (manifest.keyTemplate !== KEY_TEMPLATE) {
        throw bad(`keyTemplate must be "${KEY_TEMPLATE}"`);
    }
    if (!isString(manifest.classification)) throw bad('classification');
    if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
        throw bad('stages');
    }
    const seen = new Set();
    for (const stage of manifest.stages) {
        if (
            !isString(stage?.id) ||
            stage.id.includes('/') ||
            seen.has(stage.id) ||
            typeof stage.loadable !== 'boolean' ||
            typeof stage.readable !== 'boolean'
        ) {
            throw bad('stages');
        }
        seen.add(stage.id);
    }
    if (!seen.has(manifest.inputStage)) throw bad('inputStage');
    if (
        !seen.has(manifest.resultKey?.stage) ||
        !isString(manifest.resultKey?.id)
    ) {
        throw bad('resultKey');
    }
    if (
        manifest.accountKey !== undefined &&
        !isString(manifest.accountKey)
    ) {
        throw bad('accountKey');
    }
    return manifest;
}

/** The manifest entry for a stage id, or a usage error listing valid ids. */
export function stageEntry(manifest, stage) {
    const entry = manifest.stages.find((s) => s.id === stage);
    if (!entry) {
        throw new PipelineError(
            `Unknown stage "${stage}". This pipeline's stages: ${manifest.stages.map((s) => s.id).join(', ')}.`,
            EXIT.USAGE,
        );
    }
    return entry;
}

/** Rejects run ids that would escape their `{stage}/{runId}/` prefix. */
export function assertSafeRunId(runId) {
    // eslint-disable-next-line no-control-regex
    if (!isString(runId) || /[/\\\u0000-\u001f]/.test(runId) || runId === '.' || runId === '..') {
        throw new PipelineError(
            `Invalid run id "${runId}": it must be non-empty and cannot contain "/" or control characters.`,
            EXIT.USAGE,
        );
    }
    return runId;
}

/** Rejects object ids that are empty, absolute, or contain `..` segments. */
export function assertSafeId(id) {
    if (
        !isString(id) ||
        id.startsWith('/') ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f]/.test(id) ||
        id.split('/').some((seg) => seg === '..' || seg === '.')
    ) {
        throw new PipelineError(
            `Invalid object id "${id}": it must be non-empty, relative, and cannot contain "." / ".." segments or control characters.`,
            EXIT.USAGE,
        );
    }
    return id;
}

export function prefixFor(manifest, stage, runId) {
    stageEntry(manifest, stage);
    assertSafeRunId(runId);
    return `${stage}/${runId}/`;
}

export function keyFor(manifest, stage, runId, id) {
    return `${prefixFor(manifest, stage, runId)}${assertSafeId(id)}`;
}
