# Operating the bot

This guide starts one controlled seat against a Keyteki-compatible server. It assumes the package has been installed and built. Read [runtime setup and boundaries](runtime-notes.md) for the browser ownership contract, supported operating systems and exact recovery limits.

## 1. Create your local configuration

Use your own server, account and server-side deck-selection ID:

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/my-bot" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name'
```

The command creates a private directory, a `seat.json`, and an empty-password `credentials.json`. Fill the password in that local file. The initializer refuses existing destinations and does not open a browser. Do not place real account files in `examples/`.

The origin must be an exact HTTP(S) origin. The server deck ID is not necessarily a Master Vault UUID. If the deployment has a game socket on another origin, explicitly supply each complete HTTP(S) socket path using `--game-socket-path`; same-origin is the default. No previous server address is built in.

The default policy is `tactical-style-engine-v3`. It is a code policy and requires no language-model key. Table chat is disabled. `ownAccountNames` should list all of your accounts so matchmaking can exclude them.

## 2. Check the configuration

```sh
node bin/kf-auto.mjs preflight \
  --config "$PWD/.local/my-bot/seat.json" \
  --create-public
```

Inspect `readyForExplicitRun`. Preflight checks required files, credential-file permissions and output freshness. It does not read the password, contact the site, verify that login succeeds, or certify the live UI. An empty credential template can pass the filesystem checks; the password must still be filled before an actual run.

The managed runtime needs Linux (including Linux inside WSL), Node 22.12–24.x, Python 3 with `fcntl` and pidfd support, and a direct Chromium binary. Playwright's matching Chromium is the default. `KF_BOT_CHROME` can select a direct ELF binary; shell wrappers are rejected.

## 3. Start a single game

To create one AI-labelled public beginner room and wait for a non-owned opponent:

```sh
node bin/kf-auto.mjs seat create \
  --config "$PWD/.local/my-bot/seat.json"
```

The launcher checks the selected account and deck, room identity, participants and first native game view before activating the strategy. One account is controlled. The opponent's hidden hand and unknown deck order are not strategy inputs.

To join an observed room, use a fresh seat configuration with the exact observed `room.gameId`, `room.opponentName`, room name and type. Run preflight without `--create-public`, then use `seat run`. An old output directory is not silently reused for a different game.

The login, deck-picker and room automation was developed on a localized Keyteki deployment. Current public TCO unattended login/lobby operation has not been validated for this extracted release. A configured origin or a userscript URL match does not extend that claim.

## 4. Freeze a runtime for repeated games

A campaign binds the exact runtime and executable files before starting attempts:

```sh
node bin/kf-auto.mjs runtime freeze \
  --output "$PWD/.local/runtime-v1"

node bin/kf-auto.mjs campaign prepare \
  --seat "$PWD/.local/my-bot/seat.json" \
  --manifest "$PWD/.local/runtime-v1/runtime-manifest.json" \
  --config "$PWD/.local/my-bot/campaign.json" \
  --output "$PWD/.local/my-bot/campaign-data" \
  --id my-campaign
```

Both commands prepare local files. They do not start a game. Freeze includes the public runtime and its production npm dependencies, and hashes the selected Node, Python and Chromium installation. It does not copy credentials, profiles or campaign data. This is a content snapshot, not a container or a complete operating-system image.

Start from the frozen entry point:

```sh
node .local/runtime-v1/tools/cli.mjs campaign run \
  --config "$PWD/.local/my-bot/campaign.json"
```

Using the development entry point with a manifest belonging to another root is rejected. Changing a pinned runtime or executable requires a new snapshot and appropriate campaign configuration; do not edit an existing manifest to conceal a mismatch.

The supervisor holds an account lock, starts one worker per attempt, checks storage and health, and records natural outcomes separately from technical failures. The default free-space guard is 5 GiB. It can be explicitly configured through `minimumFreeBytes`, with a 128 MiB minimum. The guard does not delete older results.

## 5. Observe and pause

For an already started campaign:

```sh
node .local/runtime-v1/tools/cli.mjs campaign status \
  --config "$PWD/.local/my-bot/campaign.json"

node .local/runtime-v1/tools/cli.mjs campaign pause \
  --config "$PWD/.local/my-bot/campaign.json"
```

Pause requests stop after the current attempt. The initial observation phase also pauses for operator inspection after the health criteria have been met. Only an eligible, stable state can use:

```sh
node .local/runtime-v1/tools/cli.mjs campaign enable-unattended \
  --config "$PWD/.local/my-bot/campaign.json"
```

Then restart `campaign run` from the same frozen runtime. This operation does not clear unrelated pause reasons, uncertain sends or unresolved attempts. A campaign that has never started returns `CAMPAIGN_NOT_STARTED` for status; preparing a configuration does not fabricate a running checkpoint.

The lower-level `host status|pause|resume|stop --profile DIR` commands address an existing local bridge profile. `host start` uses the launcher's generated `bridge-config.json`, not a seat configuration. Normal seat/campaign operation manages that host itself.

SIGINT/SIGTERM preserve operator-pause semantics. A supervisor process stopping is not proof that the native seat, driver, local host and managed browser have all retired. Do not use a service wrapper that unconditionally restarts over unresolved state. This release deliberately supplies no automatic service installation.

## 6. Recover only from a supported state

Two separate command families expose the existing bounded recovery transactions:

| Command | Purpose |
| --- | --- |
| `recovery storage prepare` | Prepare a request bound to the actual paused configuration, runtime and records. |
| `recovery storage commit` | Revalidate and apply that explicit request. |
| `recovery unjoined prepare` | Prepare reconciliation for the exact reviewed pre-join guard, using a stop receipt. |
| `recovery unjoined commit` | Recheck native absence, zero game sends, process/lease state and file identities, then apply the transaction. |

Each `prepare` writes a new request file; `commit` takes `--request FILE`. Run `node bin/kf-auto.mjs --help` for the complete options.

These commands are not general “delete the checkpoint and retry” tools. Uncertain game-command delivery requires exact owner, ticket, sequence and observed-effect evidence. It is never resolved by replaying a possibly accepted command. Local request timeout and game effect are separate facts.

Unjoined reconciliation applies to the pinned guard files in this package. It does not promise recovery of historical private installations or other versions. Missing evidence leaves the original state preserved.

## Keep operational data local

The repository contains synthetic examples and tests. Your runtime output can contain account names, endpoints, player views and diagnostic receipts. Keep it under an ignored local directory. If reporting a bug, provide the error code, package version and a minimal synthetic reproduction; inspect any log before sharing it.
