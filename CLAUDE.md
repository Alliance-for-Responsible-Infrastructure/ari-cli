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
read from `ari-config.json` at startup, plus a `pipeline` command with `deploy`/`run`/`wait`/`status`/`runs`/`stop`/`history`/`logs`/`fetch`
and `data stages|ls|load|get|inspect|cat` subcommands (see "Pipeline commands" below). The binary is exposed as the `ari` command.

### Code Layout

```
src/
  classes/
    base-entity.js     # loads ari-config.json (public) + ~/.ari/config.json (local), merge helper
    base-command.js    # queue-based execute(), AWS env cleanup, version check
    credentials.js      # CredentialsCommand + printAccountsList()
    init.js              # InitCommand — interactive wizard + --from-file
    pipeline.js          # PipelineRun/Wait/Status/Runs/Stop/History/Logs/Deploy commands
    pipeline-data.js     # PipelineData{Stages,Ls,Load,Get,Inspect,Cat}Command (get also serves `fetch`)
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
      pipeline.js        # named-pipeline SSM lookup, Step Functions + CloudWatch Logs calls — pure AWS SDK
      pipeline-utils.js  # pure helpers: exit codes, parseDuration, error classifiers, foldHistory, log line allow-list
      manifest.js        # pure: schema-1 manifest validation, {stage}/{runId}/{id} keys
      content-gate.js    # the content gate: readable allow-list, banner, caps, binary sniff, 0600 writes, path warnings
      data-inspect.js    # structure-only CSV/JSON inspection (never returns values)
      prompt.js          # TTY detection + y/N confirm

tests/
  classes/     # Jest tests mirroring src/classes
  commands/    # runCommand exit-code mapping
  lib/         # lib layer tests (injected `deps`, no AWS SDK mocking) + pure helper tests
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

`ari pipeline run <name>` / `ari pipeline status <name> <runId>` / `ari pipeline deploy <name>` (+ `diff`/`synth`)
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
- `deploy` / `diff` / `synth` are thin, cwd-based wrappers around `npx cdk <verb>` (spec C4) — not a
  name → repo-path registry (decided: stay cwd-based). `PipelineDeployCommand`, `PipelineDiffCommand`
  and `PipelineSynthCommand` share `PipelineCdkCommand` in `src/classes/pipeline.js`. Must be run from
  inside the named pipeline's own repo directory: it reads that repo's own `./config/default.json`
  directly off disk (plain `fs.readFileSync`, not the `config` npm package, which resolves relative
  to `ari-cli`'s own install location) for `projectName`, `iac.account`, `iac.region`. Guards, all
  exit 2 and all before cdk is spawned: name mismatch; `iac.account` unmapped in `~/.ari/config.json`
  (fail closed); STS account != mapped id; `AWS_REGION`/`AWS_DEFAULT_REGION` set and != `iac.region`;
  (deploy/diff) SSM `/cdk-bootstrap/<qualifier>/version` missing (qualifier from `cdk.json` context
  `@aws-cdk/core:bootstrapQualifier`, validated, default `hnb659fds`). `deploy --bootstrap` confirms
  (`--yes` off a TTY) then runs `cdk bootstrap aws://<acct>/<region>` before deploy.
  `--require-approval` is a commander choice; `never` warns and needs `--yes` off a TTY. cdk is spawned
  with `spawnSync`, a fixed allow-listed argv (no arbitrary passthrough), `stdio: 'inherit'`, and
  `AWS_BEARER_TOKEN_BEDROCK` stripped from the env. No `--region`/`--profile` flags by design (single
  source of truth for the guard). Helpers `getCallerAccount`/`getBootstrapVersion` are in
  `src/lib/cli/aws.js`.


## Roadmap

All three `pipeline` subcommands (`run`, `status`, `deploy`) now make real AWS/CDK calls — no
remaining stubs. `run` also takes an optional `--run-id <id>` to reuse a specific run id (e.g. one
already loaded with data) instead of generating a fresh one. See "Pipeline commands" above and
`ari-cli/references/pipeline-cli-workflow-steps.md` for the current round of work closing the
"never actually deployed/run end-to-end" gap, and `ari-cli/references/project-notes.md`, step 9, for
the original design history.
