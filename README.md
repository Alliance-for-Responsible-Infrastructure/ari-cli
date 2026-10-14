# ari-cli

A small CLI for ARI (Alliance for Responsible Infrastructure) collaborators to work with ARI's AWS
accounts without needing to know AWS tooling in detail.

## Prerequisites

- Node.js v22 (see `.nvmrc`). That's it — no AWS CLI install required; `ari-cli` talks to AWS
  directly via the AWS SDK.

## Install

```bash
npm install -g github:Alliance-for-Responsible-Infrastructure/ari-cli
```

Re-run the same command any time to update to the latest version.

## Setup

This repo is open and contains no org-specific AWS details (account IDs, SSO URL/region) — those
live in a local config at `~/.ari/config.json` that you create once per machine:

```bash
ari init
```

This asks for the SSO start URL, SSO region, and each account's AWS account ID. **If a teammate
already has this set up, it's much easier to ask them to share their `~/.ari/config.json`** (e.g.
via a password manager or a DM) and run:

```bash
ari init --from-file /path/to/their-config.json
```

than to type everything in by hand.

## Usage

### Authenticate with an ARI AWS account

```bash
# See which accounts and roles are available
ari credentials --list

# Authenticate against the public account with the default role (ViewOnlyAccess)
ari credentials --account public

# Authenticate against the management account with AdministratorAccess
ari credentials --account management --role AdministratorAccess

# Force a fresh SSO login even if a cached session looks valid
ari credentials --account controlled --force
```

This opens an AWS SSO login in your browser (first run, or after your session expires) — you'll see
a code in the terminal, confirm it matches what's shown in the browser, then approve. `ari-cli` then
writes the resulting credentials to `~/.aws/credentials` so any AWS CLI command, SDK, or tool just
works — no `AWS_PROFILE` juggling required (and no need to have the AWS CLI installed at all).

### Scripting

Use `--print` to get the credentials as `export` statements instead of writing them to disk, e.g.
for passing to a subprocess in CI or a script:

```bash
eval $(ari credentials --account public --print)
```

### Named pipelines

A "pipeline" is a named, independently deployed stack built on `ari-iac` (e.g. ARI's Bedrock
parse/verify/filter document pipeline, `ari-pipeline-contingency-analysis-data`). `ari-cli` stays
generic here — it only knows how to start/check an execution by name, not what any pipeline
actually does.

```bash
# Start a run — generates a runId and prints it back to you
ari pipeline run production-ari-pipeline-contingency-analysis-data

# Check a run's status
ari pipeline status production-ari-pipeline-contingency-analysis-data run-20261004120000-abc123

# Deploy a pipeline's stack — run from inside that pipeline's own repo directory
ari pipeline deploy production-ari-pipeline-contingency-analysis-data

# Reuse a specific runId (e.g. one you already loaded data under) instead of a generated one
ari pipeline run production-ari-pipeline-contingency-analysis-data --run-id poc-001
```

#### Waiting, monitoring and stopping runs

```bash
# Start and wait for the result (exit code: 0 SUCCEEDED, 10 FAILED, 11 TIMED_OUT, 12 ABORTED)
ari pipeline run <name> --wait [--interval 5] [--timeout 2h] [--json]
ari pipeline wait <name> <runId>          # same loop for a run that is already going

ari pipeline runs <name> [--status FAILED] [--limit 20 | --all] [--json]
ari pipeline history <name> <runId> [--failed-only] [--show-cause] [--json]
ari pipeline logs <name> <runId> [--source sfn|lambda|all] [--follow] [--since 15m] [--limit 200] [--full]
ari pipeline stop <name> <runId> [--yes] [--cause <text>]
ari pipeline status <name> <runId> [--show-output]
```

Exit codes: `0` success, `1` error, `2` usage error / refused by a safety gate, `3` `--timeout` reached (run
still going), `4` credentials expired while waiting (run unaffected), `10`/`11`/`12` execution
FAILED/TIMED_OUT/ABORTED, `130` Ctrl-C (which only stops *waiting*; the run is never stopped implicitly).
`history` and `logs` print names, timings, attempt counts and error codes only, never step input/output;
`status` hides the execution output unless `--show-output`; `stop` asks for confirmation (`--yes` off a
terminal). Every command checks that your credentials are for the pipeline's own account.

`logs --source sfn` (default) shows Step Functions events. `--source lambda` (and `all`) shows the step-runner
Lambda logs: it reads the log group names from the pipeline's manifest (`/ari/pipelines/<name>/manifest`, written by
`ari-iac`'s `PipelineRegistry`) and errors clearly if the pipeline hasn't been redeployed with one. Only fixed-format
lines are shown (START/END/REPORT figures, the per-invocation metric line, error codes); any other line is replaced
by `[line withheld ...]`, so log content can never leak. Lambda platform lines carry no run id, so they are selected
by the run's time window and concurrent runs may interleave (the command says so).

#### Reading and loading pipeline data

These commands are driven by the pipeline's **manifest** (`/ari/pipelines/<name>/manifest`, schema 1: stages with
`loadable`/`readable` flags, `inputStage`, `resultKey`, `bucketName`, `classification`, `accountKey`), so they work
from any directory. A pipeline deployed before the manifest existed fails with a "redeploy" message.

```bash
ari pipeline data stages <name>                                  # stages, prefixes, loadable/readable (no S3 call)
ari pipeline data load <name> <localDir> --run-id <id> [--stage <s>] [--yes]   # upload top-level files to the input stage
ari pipeline data ls <name> <runId> [--stage <s>] [--match <text>] [--ids] [--json]   # keys/sizes/dates only
ari pipeline data inspect <name> <runId> <id> --stage <s> [--json]   # STRUCTURE ONLY: columns, row count, JSON key shape, sizes
ari pipeline data cat <name> <runId> <id> --stage <s> [--max-bytes <n>] [--head <lines>] [--yes]   # gated
ari pipeline data get <name> <runId> [<id>] [--stage <s>] [--out <path>] [--force] [--yes]         # gated; no id = result key
ari pipeline fetch <name> <runId> [--out <path>] [--force] [--yes]                                 # gated; the manifest's resultKey
```

Prefer them in this order: `ls` / `inspect` (nothing printed or stored; `inspect` still reads the object in the CLI
process, so it needs `s3:GetObject` and is recorded in CloudTrail), then `cat` (bounded, terminal), then `get`/`fetch`
(a file on your machine).

**The content gate** (`get`, `cat`, `fetch`) has no bypass: no environment variable, config setting or flag
other than the per-call `--yes`. It (1) only allows stages the manifest marks `readable` (so not `raw/`), (2) prints a
banner naming account, bucket, key, size, version id and your identity (the read is recorded in CloudTrail; the CLI
keeps no log of its own), (3) asks y/N on a terminal, or requires `--yes` off one (exit 2 otherwise), (4) refuses
binary objects (NUL bytes in the first 4 KiB), (5) for `cat` reads at most `--max-bytes` (default 64 KiB, hard cap
1 MiB) with a ranged request, (6) writes downloads with mode `0600`, never overwrites without `--force`, and warns
if the path is in a git work tree or a cloud-sync folder. `ls`, `inspect`, `stages`, `load` never print object
content. Until the `AriPipelineOperator` permission set exists, these need `AdministratorAccess`.

Account guard: the caller's account must equal the account in the state machine ARN **and**, when the manifest has an
`accountKey`, the account id for that key in `~/.ari/config.json` (`ari init`).

`<name>` is the pipeline's `projectName` (`{environment}-{workloadName}` from its own
`config/default.json`, e.g. `production-ari-pipeline-contingency-analysis-data`) — `run`/`status`
resolve it to a state machine ARN via an SSM parameter (`/ari/pipelines/<name>/stateMachineArn`)
that pipeline's own stack declares; there's no separate registration step. Pass `--region` if the
pipeline isn't deployed in `us-east-1` (the default). `status` reports the Step Functions
execution's own status — for per-file detail, check that pipeline's own CloudWatch logs or state
table. `deploy` must be run
from inside the named pipeline's own repo directory — it reads that repo's own
`config/default.json` to confirm `<name>` matches, then shells `npx cdk deploy` with its output
and any interactive prompts passed straight through.
