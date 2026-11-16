# KeyForge TCO Bot

An experimental, observation-based strategy and browser automation stack for
Keyteki-compatible servers. It includes the strategy host, native player-view
adapter, browser bridge, watchdog, room lifecycle and sequential game campaigns.

This is a standalone extraction of the client and strategy components, including
the static card knowledge used by the strategies. The private KeyForge rules
engine, game server, game UI and historical match data are not included.

[中文说明](README.md) · [Architecture](docs/architecture.md) ·
[Card knowledge](docs/card-knowledge.md) · [Operations](docs/operations.md) ·
[Strategies and historical Elo](docs/strategy-guide.md) · [International TCO and chat language](docs/international-tco.md) · [Validation](docs/validation.md)

## What is included

- Code strategies operating on the player's own visible information and the
  opponent's public information, including the Engine V3 strategy family.
- Projection of native player state, menu navigation, physical card binding,
  allocation and native command compilation.
- A loopback strategy host with per-document ownership, send tickets and
  separate prepared / queued / effect-observed accounting.
- A browser bridge with bounded request timeouts and an independent watchdog.
  Exact observed-delivery reconciliation does not replay an uncertain command.
- Single-seat join/create flows, normal terminal retirement, account locks,
  campaign health gates, explicit pause and bounded recovery procedures.
- A portable Chromium backend and explicit local configuration. OpenClaw,
  subscription credentials and the original research repository are not runtime
  dependencies. Optional social chat is disabled by default.

## Compatibility

The protocol adapter was developed against Keyteki revision
`361c085bcd401c20976ee9bcc4e4e5b8c061d56c`. The predecessor was used on a
Keyteki-derived deployment; the extracted package is a new build with its own
knowledge boundary.

Version 0.4.0 adds English UI and table-chat support. Anonymous visits to the
international site's home, login and play pages have been performed. **Authenticated
end-to-end games on international TCO are still pending validation.** Public-page
checks and local component tests are recorded separately from live game acceptance.
See [international TCO configuration and status](docs/international-tco.md).

The managed CLI currently targets **Linux or Linux inside WSL**, Node.js
**22.12–24.x**, Python 3 and Chromium. Process identity and recovery use Linux
`/proc` and kernel file locks. Native Windows and macOS supervision are not
claimed to be supported.

## Install

```sh
git clone https://github.com/AxelHu/keyforge-tco-bot.git
cd keyforge-tco-bot
npm ci
npm run build
npx playwright install chromium
node bin/kf-auto.mjs --help
```

A system Chromium executable can be configured instead of downloading one.
Installing dependencies, building and running the offline tests do not log
into a server or start a game.

## Quick start

The repository includes the strategy, static knowledge, bridge and supervision
components required to run independently. After installing dependencies,
building and supplying your local configuration on supported Linux, you can
start through the CLI without the private KF engine or OpenClaw. The target
site must still match the supported login, deck-selection and room protocols.
See the [international TCO guide](docs/international-tco.md) before using that deployment.

Create a new local configuration:

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/my-bot" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name' \
  --policy tactical-style-engine-v3
```

Fill the actual password in the generated local `credentials.json`, then run:

```sh
node bin/kf-auto.mjs preflight \
  --config "$PWD/.local/my-bot/seat.json" \
  --create-public

node bin/kf-auto.mjs seat create \
  --config "$PWD/.local/my-bot/seat.json"
```

Preflight does not read the password, log in or certify the site's UI.
`seat create` opens the browser and attempts room creation. See the
[operation guide](docs/operations.md) for joining an observed room, freezing a
runtime and running campaigns. Keep real configuration, browser profiles and
decision logs under the ignored `.local/` directory. The credential file must
be private to its owner.

## Strategy menu

```sh
node bin/kf-auto.mjs strategies list
node bin/kf-auto.mjs strategies list --all
node bin/kf-auto.mjs strategies show tactical-style-engine-v3
```

The common menu lists **Engine V3 (default), ToC V2, Cycle V2, Effects V4 and
Control V2**. All **89 registered code-policy IDs** from the predecessor remain
available, including specialist, experimental and historical entries.

Menu commands do not contact a server, open a browser or modify existing
configuration. Use `init --policy ID`, or the optional `--choose-policy`
numbered menu in an interactive TTY; these options are mutually exclusive.
An unstarted seat configuration can also set `self.codePolicy` directly.
The [strategy guide](docs/strategy-guide.md), maintained in Chinese, explains
the policies and the **2026-11-13 historical Elo table**. Those ratings bind
the recorded frozen implementation and are not new measurements of the
current public code.

## Strategy and knowledge boundary

Strategies are heuristics over the current observation. The remote server
remains the authority for legality and game resolution. The default knowledge
pack preserves all 2,546 static definitions from the predecessor catalog, `summary` text and
`ruleInterpretations` annotations used by the strategies. These are read-only
strategy inputs; this package does not include a local game rules engine.

The evaluator supports a bounded set of effects. Retaining a complete card
definition does not certify every interaction or treat unknown effects as a
known zero. See [card knowledge](docs/card-knowledge.md) for the data, scoring
coverage, unsupported effects and extension interface. Card names, rules text
and interpretation annotations retain their original language. The core
operation and architecture documents are currently maintained in Chinese.

## Development

```sh
npm test
npm run check:package
```

Tests use synthetic observations, timers, transport and HTTP boundaries. They
exercise the production components without constructing a private-engine game
or connecting to a public game server. The package-boundary check also checks
relative module dependencies and accidental inclusion of engine/data paths.

Historical predecessor results included 17 wins and 3 losses in 20 natural
games against one fixed external opponent/deck, plus one separate technical
concession. Those results belong to their original frozen build, **not this
extracted release**. They are not an estimate of this package's current win
rate. See [validation](docs/validation.md) for what has actually been tested.

## License

Original code is provided under [MIT](LICENSE). Dependency licenses, protocol
references and separately attributed source card text are described in
[NOTICE](NOTICE.md); the project does not relicense third-party text under MIT. This is an unofficial project
and is not affiliated with the game publisher or The Crucible Online operators.
