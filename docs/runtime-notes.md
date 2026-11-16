# Runtime setup and boundaries

This package contains the local strategy host, player-view adapter, browser bridge, one-seat launcher, watchdog, campaign supervisor, and bounded recovery tools. It does not run a local KeyForge rules server or an arena. The shared strategy chooses only from the observed native action surface; the remote server remains responsible for the game.

The automated UI flow was observed on a localized Keyteki deployment. The userscript includes a TCO URL match, but this extracted package has not been live-tested against the official TCO domain. Configuring an origin does not certify its login, deck-selection, room, or node UI. A changed or unsupported native surface stops the binding rather than guessing a room, account, deck, or action.

## Installation

The runtime currently supports Linux, Node 22.12 through 24.x, Python 3 with `fcntl`, and Chromium. Managed process signals require Python/Linux `pidfd_open` and `pidfd_send_signal`; unavailable or unverifiable identity does not fall back to a reusable PID.

```sh
npm ci
npm run build
npx playwright install chromium
node bin/kf-auto.mjs --help
```

Playwright is a declared package dependency. No global agent configuration or separately installed browser helper is required. By default its matching Chromium executable is used. To select another installation, set `KF_BOT_CHROME` to the direct ELF Chromium binary; shell launcher wrappers are rejected. Chromium sandboxing is enabled by default. `KF_BOT_NO_SANDBOX=1` is an explicit deployment option for environments that require it.

## Create local configuration

Use values belonging to your account and selected deck. The server deck ID is the native site's deck-selection ID, not a guessed Master Vault identifier.

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/demo" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name'
```

This writes `seat.json` with absolute local paths and a private `credentials.json` template. Fill its empty password locally. The initializer never starts a browser and refuses to overwrite an existing directory. The JSON files under `examples/` describe the same schemas with placeholder paths; `init` avoids having to edit absolute paths by hand.

`origin` is required and must be an exact HTTP(S) origin with no credentials, path, query, or fragment. Account and deck identities are explicit. `ownAccountNames` defaults to the one controlled account; add any other accounts you own so matchmaking will exclude them.

The default transport policy accepts same-origin node paths. If an observed deployment uses a different game-node origin, configure each exact HTTP(S) node path in `gameSocketPaths`, for example a complete `/node1/socket.io` URL on that deployment. There are no implicit IP, port, wildcard, or neighboring-node exceptions. Repeated `--game-socket-path` options are supported by `init`.

Table chat is disabled by default and is independent of the pure-code strategy. To enable the optional MiniMax provider, set `social.enabled` in the seat configuration and provide `MINIMAX_API_KEY` explicitly in the process environment. No home-directory account store is read and no model key is required for code-only play.

## One seat

```sh
node bin/kf-auto.mjs preflight --config "$PWD/.local/demo/seat.json" --create-public
node bin/kf-auto.mjs seat create --config "$PWD/.local/demo/seat.json"
```

Preflight is offline. It checks configuration, required files, private credential-file permissions, and a fresh output directory; runtime checks still verify the configured policy, actual login, selected deck, native room, both participants, and initial player view.

To join a room, fill the exact observed `room.gameId`, `room.opponentName`, room name and type in a fresh seat configuration, then use `seat run`. Public creation uses a beginner/normal room whose name identifies it as an AI game. There is one controlled seat; the opponent's private hand or unknown deck composition is not a policy input.

The local host exposes `host start/status/pause/resume/stop --profile DIR`; `start` also requires `--config FILE`. Resuming a host does not repair an unsupported game mechanism or automatically override a browser's explicit manual takeover.

## Freeze and run a campaign

```sh
node bin/kf-auto.mjs runtime freeze --output "$PWD/.local/runtime-example"
node bin/kf-auto.mjs campaign prepare \
  --seat "$PWD/.local/demo/seat.json" \
  --manifest "$PWD/.local/runtime-example/runtime-manifest.json" \
  --config "$PWD/.local/demo/campaign.json" \
  --output "$PWD/.local/demo/campaign-data" \
  --id demo-campaign
node .local/runtime-example/tools/cli.mjs campaign run --config "$PWD/.local/demo/campaign.json"
```

Run the campaign entry point from the frozen runtime named by its manifest. `campaign prepare` binds the actual manifest bytes; it does not start a browser or authorize an automatic change of account. The default code policy is `tactical-style-engine-v3`; another exported code policy can be configured without changing the lifecycle checks. This default is not a claim of comparative playing strength.

A campaign uses a kernel-held account lock and an individual worker per attempt. It validates the runtime before dispatch, observes native matchmaking, and records attempts separately from natural game outcomes. It keeps existing manual pause, unresolved-send, identity, retirement, and technical-failure conditions. The existing observation phase pauses after the required stable natural games; `campaign enable-unattended --config FILE` only applies when that existing state is eligible. `campaign pause --config FILE` requests a stop after the current attempt.

The standalone disk guard defaults to 5 GiB free and accepts an explicit `minimumFreeBytes` budget of at least 128 MiB. It checks before a new attempt; it does not delete historical results to recover space. This setting is independent of any development checkout's storage policy.

## Browser ownership and shutdown

Browser profiles and leases use the `keyforge-tco-bot` namespace. The default registry is below `~/.cache/keyforge-tco-bot/browsers`; `KF_BOT_BROWSER_ROOT` or the exact `KF_BOT_BROWSER_REGISTRY` path can override it. Launch, release and recovery use the same path functions. Use a consistent environment for one campaign and its recovery operations.

Each profile has a kernel lock, a managed process binding, an exact CDP endpoint, and individually identified clients. Unknown process/client observations are preserved. No private shared browser is silently adopted. Shell wrappers, symlinked profile paths, unknown leases and mismatched process identity do not trigger a replacement browser. Automatic retirement never deletes a user profile or a lock inode.

SIGINT/SIGTERM preserve the launcher's operator-pause behavior. Stopping a supervisor is not proof that its native seat, driver, host or managed browser has disappeared. A service wrapper must honor the campaign's current-attempt and retirement state rather than using unconditional restart or blanket process cleanup. A new campaign cannot quietly replace an unresolved active attempt.

## Recovery and evidence

The ordinary strategy ingress and independent native watchdog observation remain distinct. A bounded local request can time out without undoing an accepted host write. Recovery from an unknown delivery requires the existing exact owner, ticket, sequence and observed-effect proof; it does not infer an ACK from an empty queue or resend an uncertain game command. A successful reconciliation keeps the old context paused and uses the guarded reload/reattach path.

`recovery storage prepare|commit` retains its configuration/runtime/record bindings and transactional recovery checks. `recovery unjoined prepare|commit` is limited to the explicitly pinned pre-join guard version and requires a stop receipt, preserved originals, zero gameplay evidence, fresh native absence, process/lease checks and compare-and-swap writes. It is not a generic clear-checkpoint command. Pins in this package identify this package's reviewed files; this is not a migration promise for unrelated historical installations.

Campaign output is private operational state. It can contain account identifiers, endpoints, player-view diagnostic files, and credentials in a separate configured file. Do not copy it into a public release. Published examples contain no actual account, deck UUID, credentials or installation paths.

## What a runtime manifest proves

Freeze uses an explicit allowlist: production `tools` JavaScript, compiled `dist/src`, the binary wrapper, package metadata, and the production npm dependency closure. It excludes tests, examples, private state, campaign data, source engine and Git metadata. Compiled replica/server directories and symlinked inputs are refused. Existing output directories are never replaced, and the manifest is published after the copied files; a failed partial output is retained for inspection.

The manifest records content hashes and local Node, Python and Chromium execution paths. New content-fingerprint manifests also re-collect the exact runtime/dependency file set before dispatch, so newly added modules cannot silently shadow a frozen dependency. Legacy manifests keep their explicitly narrower verification contract. A new manifest also requires the same executable selection at campaign verification, so an environment override cannot silently select an unpinned browser. External browser resources are hashed for a Playwright-managed installation; system installations pin the direct executable. This is not a hermetic operating-system image. No Git commit is fabricated: `sourceCommit` is null and `sourceFingerprint` identifies the frozen runtime bytes.

The extraction author added offline tests for configuration, exact endpoint scope, process identity, pidfd signaling, lease identity, CLI routing, and frozen-file scope. Test execution and live-site validation are separate work owned by the release maintainer; these notes do not claim a new live game or TCO validation.
