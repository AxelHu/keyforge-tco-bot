# KeyForge TCO Bot

An experimental, observation-based strategy and browser automation stack for
Keyteki-compatible servers. It includes the strategy host, native player-view
adapter, browser bridge, watchdog, room lifecycle and sequential game campaigns.

This is a standalone extraction of the client and strategy components, including
the static card knowledge used by the strategies. The private KeyForge rules
engine, game server, game UI and historical match data are not included.

[中文说明](README.md) · [Architecture](docs/architecture.md) ·
[Card knowledge](docs/card-knowledge.md) · [Operations](docs/operations.md) ·
[Validation](docs/validation.md)

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

The browser user script includes The Crucible Online matching, but that alone
does not establish end-to-end compatibility with the current public site's
login, lobby and deck-picker UI. Public TCO unattended operation has not been
validated for this release. Set the origin explicitly and consult the
[compatibility and validation notes](docs/validation.md).

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

Configure your own server origin, username, deck identifier and private
credential file using the examples and the [operation guide](docs/operations.md).
Keep local configuration, profiles and decision logs under the ignored
`.local/` directory. The credential file must be private to its owner.

The CLI exposes preflight, single-seat run/create, host management, campaign
management, runtime freezing and explicit recovery. Run preflight before an
actual seat run. The operation guide distinguishes a paused process from a
confirmed native seat exit and completed resource retirement.

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
