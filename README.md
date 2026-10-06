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
parse/verify/filter document pipeline, `ari-pipeline-bedrock-docs`). `ari-cli` stays generic here —
it only knows how to start/check an execution by name, not what any pipeline actually does.

```bash
# Start a run — generates a runId and prints it back to you
ari pipeline run dev-bedrock-docs

# Check a run's status
ari pipeline status dev-bedrock-docs run-20261004120000-abc123

# Deploy a pipeline's stack — run from inside that pipeline's own repo directory
ari pipeline deploy dev-bedrock-docs

# Reuse a specific runId (e.g. one you already loaded data under) instead of a generated one
ari pipeline run dev-bedrock-docs --run-id poc-001
```

`<name>` is the pipeline's `projectName` (`{environment}-{workloadName}` from its own
`config/default.json`, e.g. `dev-bedrock-docs`) — `run`/`status` resolve it to a state machine ARN
via an SSM parameter (`/ari/pipelines/<name>/stateMachineArn`) that pipeline's own stack declares;
there's no separate registration step. Pass `--region` if the pipeline isn't deployed in
`us-east-1` (the default). `status` reports the Step Functions execution's own status — for
per-file detail, check that pipeline's own CloudWatch logs or state table. `deploy` must be run
from inside the named pipeline's own repo directory — it reads that repo's own
`config/default.json` to confirm `<name>` matches, then shells `npx cdk deploy` with its output
and any interactive prompts passed straight through.
