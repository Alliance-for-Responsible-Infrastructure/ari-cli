# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Lint
yarn lint

# Format
yarn format

# Run all tests (lint + jest)
yarn test

# Run a single test file
node --experimental-vm-modules node_modules/jest/bin/jest.js --setupFiles dotenv/config <path>
# Example:
node --experimental-vm-modules node_modules/jest/bin/jest.js --setupFiles dotenv/config tests/classes/credentials.test.js
```

## Architecture

**ari-cli** is a Commander.js CLI that shrinks the AWS surface area for ARI (Alliance for Responsible
Infrastructure) collaborators who mostly don't know AWS tooling. It wraps AWS IAM Identity Center
SSO login + credential activation behind a single `ari credentials` command. It's a pure ES modules
project (`"type": "module"`) requiring Node v22 (see `.nvmrc`) — and nothing else; the SSO login and
credential fetch are done directly via the AWS SDK (`@aws-sdk/client-sso-oidc`, `@aws-sdk/client-sso`),
not by shelling out to the `aws` CLI, so there's no separate AWS CLI install for collaborators to get
right.

This repo is public and intentionally contains **no org-specific AWS details** — account IDs, the
SSO start URL, and the SSO region are never committed here. `ari-config.json` (shipped with the
package) only has non-identifying structure: account keys/friendly-names and the allowed IAM roles.
The actual org-specific values live in `~/.ari/config.json`, a per-machine file created by `ari init`
(see `src/classes/init.js`) and read by `BaseAriEntity`/`src/lib/local-config.js`. Never add real
account IDs or the SSO start URL back into `ari-config.json` or any other repo file.

It was scaffolded from `hero-cli` (a sibling CLI for a different org) — the queue-based command
execution engine, SSO/credential plumbing, and config-driven option validation patterns are shared;
everything HERO-specific (MFE generators, deploy pipelines, service exec, AST migrations) was left
behind.

### Entry Point

`index.js` — registers the `credentials` command via Commander.js, with `--account`/`--role` choices
read from `ari-config.json` at startup, plus a `pipeline` command with `deploy`/`run`/`status`
subcommands (see "Pipeline commands" below). The binary is exposed as the `ari` command.

### Code Layout

```
src/
  classes/
    base-entity.js     # loads ari-config.json (public) + ~/.ari/config.json (local), merge helper
    base-command.js    # queue-based execute(), AWS env cleanup, version check
    credentials.js      # CredentialsCommand + printAccountsList()
    init.js              # InitCommand — interactive wizard + --from-file
    pipeline.js          # PipelineRunCommand / PipelineStatusCommand / PipelineDeployCommand
  commands/
    credentials.js      # thin handler: --list short-circuit, then CredentialsCommand.execute()
    init.js              # thin handler: InitCommand.run()
    pipeline.js          # thin handlers: deploy/run/status, each wraps execute() in try/catch
  lib/
    require-json.js, is-local.js, version-check.js, program-utils.js
    local-config.js      # ~/.ari/config.json read/write (org-specific, never committed)
    cli/
      terminal.js        # picocolors-based styles (success/error/warn/emphasis/bold)
      aws.js             # SSO device-flow login, role credential fetch/verify/write — pure AWS SDK
      pipeline.js        # named-pipeline SSM lookup, StartExecution/DescribeExecution — pure AWS SDK

tests/
  classes/     # Jest tests mirroring src/classes
  helpers/     # Shared test utilities
```

### Key Design Patterns

**Command → Class delegation**: `src/commands/credentials.js` does the minimum (handle `--list`,
validate `--account` is present, then instantiate `CredentialsCommand` and call `execute()`). All
logic lives in `src/classes/`.

**Queue-based execution** (`BaseAriCommand`): Commands build ordered async action queues via
`addAction(fn)` and `addFinally(fn)`, then call `execute()` to run them sequentially. `finallyQueue`
always runs (cleanup). `execute()` also strips any `AWS_*` env vars inherited from the shell (e.g.
a prior `eval $(ari credentials --print)`) so both in-process AWS SDK clients and subprocesses use
the credentials ari-cli itself manages.

**Class hierarchy**:

- `BaseAriEntity` — loads `ari-config.json` (public) + `~/.ari/config.json` (local), tracks CWD and
  options, and exposes `getAccountConfig(key)` to merge the two (friendly name + account ID)
- `BaseAriCommand extends BaseAriEntity` — adds action/finally queues, debug mode, version check

**Config-driven accounts/roles**: `ari-config.json`'s `credentials.accounts` / `credentials.roles`
are the single source of truth for what `--account`/`--role` accept — `index.js` builds Commander
`Option#choices()` from them, so adding an account or a future custom role is a config edit, not a
code change. Adding a new account still requires each user to add its account ID via `ari init`.

### Pipeline commands

`ari pipeline run <name>` / `ari pipeline status <name> <runId>` / `ari pipeline deploy <name>`
(step 9 of the plan in `ari-cli/references/project-notes.md`) — generic over any pipeline built on
`ari-iac` (e.g. `ari-pipeline-contingency-analysis-data`, the first real one). Deliberately carries
zero pipeline-specific logic — no knowledge of what a pipeline's workers do, its data shape, or its
DynamoDB schema — same "stay generic" principle `credentials` follows for AWS services.

- `run` / `status` resolve `<name>` (a pipeline's `projectName`, e.g.
  `production-ari-pipeline-contingency-analysis-data`) to a state machine ARN via one
  `ssm:GetParameter` call at `/ari/pipelines/<name>/stateMachineArn` —
  the named-pipeline registry every `ari-iac`-built pipeline stack declares as a plain CDK
  resource (no separate registration step, nothing to keep in sync). `--region` (default
  `us-east-1`) is required because there's no pipeline → account/region mapping anywhere; a
  pipeline's account/region context is just whatever `ari credentials` session is currently active
  plus whatever `--region` you pass.
- `run` generates a `runId` (`generateRunId()` — timestamp + random suffix) and uses it as *both*
  the Step Functions execution's own `name` and the `{ runId }` execution input every pipeline's
  state machine expects. Using it as the execution name too is what lets `status` derive the
  execution ARN directly (`executionArnFor()`) instead of listing/searching executions.
- `status` calls `sfn:DescribeExecution` directly — the execution-level status only. It
  deliberately does NOT query a pipeline's own state table for per-file detail (`parse_status`,
  `verify_status`, ...) — that would require knowing that pipeline's own schema, exactly the kind
  of pipeline-specific knowledge this command stays out of. Points the user at that pipeline's own
  CloudWatch logs / state table when the run failed.
- `deploy` is a thin, cwd-based wrapper around `cdk deploy` — not a name → repo-path registry (that
  registry problem doesn't need solving yet). Must be run from inside the named pipeline's own repo
  directory: it reads that repo's own `./config/default.json` directly off disk (plain
  `fs.readFileSync`, not the `config` npm package, which resolves relative to `ari-cli`'s own
  install location rather than the caller's cwd) to compute
  `projectName = "{environment}-{workloadName}"` and errors loudly if it doesn't match the given
  `<name>` — a cheap "wrong directory" safety check. Then shells `npx cdk deploy` with `stdio:
  'inherit'` so CDK's own interactive diff/approval prompts and output reach the user directly;
  `ari-cli` does no AWS SDK work of its own here. `cdk bootstrap` is still a one-time, documented
  manual prerequisite per AWS account — not detected or run by this command. See
  `src/classes/pipeline.js` and `ari-cli/references/pipeline-cli-workflow-steps.md` (work breakdown
  item 3) for the design discussion.

### Configuration Registry

- `ari-config.json` (repo, public) — the three ARI account keys/friendly-names, allowed IAM roles,
  default role. This is the first place to look when adding an account or role.
- `~/.ari/config.json` (per-machine, local, created by `ari init`) — SSO start URL, SSO region, and
  each account's actual AWS account ID. Never shipped, never committed.

### CLI Utilities (`src/lib/cli/`)

`aws.js` — the whole SSO flow via AWS SDK clients, no `aws` CLI subprocess anywhere:

- `ssoLogin`/`isSsoSessionValid`: OIDC device-authorization flow (`@aws-sdk/client-sso-oidc`) with
  a local token cache at `~/.aws/sso/cache/<sha1(startUrl)>.json` — the same location/format AWS CLI
  v2 uses, so a session started by either is recognized by the other.
- `getCredentials`: `sso:GetRoleCredentials` (`@aws-sdk/client-sso`) using the cached access token —
  no `~/.aws/config` SSO profile needed.
- `verifyCredentials`: `sts:GetCallerIdentity` (`@aws-sdk/client-sts`).
- `writeDefaultCredentials`: a small hand-rolled INI reader/writer for `~/.aws/credentials` (no
  `aws configure set` subprocess).

`pipeline.js` — the named-pipeline registry lookup and Step Functions calls behind the `pipeline`
commands, no `aws` CLI subprocess here either: `resolveStateMachineArn` (`ssm:GetParameter`),
`generateRunId`, `startPipelineRun` (`sfn:StartExecution`), `executionArnFor`,
`describePipelineRun` (`sfn:DescribeExecution`). Not unit-tested directly (same convention as
`aws.js`) — mocked wholesale in `tests/classes/pipeline.test.js` when testing the command classes.

`terminal.js` (styled output via `picocolors`).

### Import Alias

Use `#src/*` for imports from the `src/` directory (defined in `package.json` `imports` field).

### Local Development

Use `npm link` to test the CLI locally.

## Roadmap

All three `pipeline` subcommands (`run`, `status`, `deploy`) now make real AWS/CDK calls — no
remaining stubs. `run` also takes an optional `--run-id <id>` to reuse a specific run id (e.g. one
already loaded with data) instead of generating a fresh one. See "Pipeline commands" above and
`ari-cli/references/pipeline-cli-workflow-steps.md` for the current round of work closing the
"never actually deployed/run end-to-end" gap, and `ari-cli/references/project-notes.md`, step 9, for
the original design history.
