# KeyForge TCO Bot

An experimental, observation-based strategy and browser automation stack for
Keyteki-compatible servers. It includes the strategy host, native player-view
adapter, browser bridge, watchdog, room lifecycle and sequential game campaigns.

This is a standalone extraction of the client and strategy components, including
the static card knowledge used by the strategies. The private KeyForge rules
engine, game server, game UI and historical match data are not included.

[中文说明](README.md) · [Architecture](docs/architecture.md) ·
[Card knowledge](docs/card-knowledge.md) · [Operations](docs/operations.md) ·
[Strategies and Elo ratings](docs/strategy-guide.md) · [International TCO and chat language](docs/international-tco.md) · [Network measurements and subsequent games](docs/international-network.md) · [Validation](docs/validation.md)

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
- Explicit browser direct/proxy routing and persistent campaign limits for natural
  games, attempts and elapsed time. When a limit is reached, no new attempt is dispatched;
  any game already in progress completes normal retirement.
- A portable Chromium backend and explicit local configuration. OpenClaw,
  subscription credentials and the original research repository are not runtime
  dependencies. Optional social chat is disabled by default.

## Compatibility and current validation

### 0.6.6 experimental opening candidates

Three opt-in ToC candidates isolate first-turn house choice, mulligan, and their combination. The original 89 IDs retain their behavior. Mulligan estimation requires a complete public physical deck list and keeps the hand when that input is unavailable. There are no new win-rate or Elo claims, and the common menu and default policy remain unchanged. [Method and API](docs/opening-policy-candidates.md)

### 0.6.5 hand valuation and seven-policy Elo

In the 192-game version comparison, 0.6.5 recorded 96 wins and 96 losses (50.00%) in complete four-game units. Every four-game unit split 2–2. The resulting [50%, 50%] intervals carry no sampling variation across these units and do not establish a population win rate of 50% or a win-rate gain. A separate seven-policy round robin completed 1,008 games and contributed 1,008 games to the Elo fit. The full offline suite passed 636/636. [Method, ratings and all head-to-head records](docs/calibration-and-strategy-elo.md) · [Rating data](docs/data/strategy-elo-20261118.json)

<!-- retention-sequence-064:start -->
### 0.6.4 hand retention and short play sequences

The candidate discounts cards that must wait for a house call and reprices remaining plays after a supported public resource or permission change. Across complete four-game units in the fixed local confirmation set, the candidate went 196–188 (51.04%). Both family intervals include 50%. This comparison does not establish a win-rate improvement. The offline suite passed 619/619. [Method and results in Chinese](docs/retention-sequence-evaluation.md) · [Public evidence](docs/evidence/retention-sequence-2026-11-18.json)
<!-- retention-sequence-064:end -->

<!-- hand-opportunity-063:start -->
### 0.6.3 hand recovery and discard decisions

In four recorded positions from one game, 0.6.2 ranked a native discard first. After accounting for refill space released by playing the same card, 0.6.3 ranked playing it first in all four. Recovered cards share the available play slots, permissions and amber. Same-house partners that remain in hand contribute a separate, bounded future value. The final offline suite passed 579/579 tests.

Across complete four-game units, the candidate went 49–47 (51.04%) in development and 197–187 (51.30%) in confirmation. Both family intervals include 50%. The experiment used 12 fixed decks and two policy families. [Method and results in Chinese](docs/hand-opportunity-evaluation.md) · [Public evidence](docs/evidence/hand-opportunity-2026-11-18.json)
<!-- hand-opportunity-063:end -->

<!-- card-lifecycle-062:start -->
### 0.6.2 card lifecycle valuation

**0.6.2** values discarding, purging, recovery, archiving and return to hand through the change in a visible card's future use opportunity, using its actual destination. Normal refill displacement is settled once per complete candidate action. Ordinary card quality reuses the public effect evaluator and its fallback; timing discounts remain heuristic, without a complete deck-wide combo search. Source `ead3992` passed **549/549** offline tests: the existing 483 plus **66** new tests covering the region model (28), recovery windows (19) and consumer integration (19).

A separate **32-game frozen-0.6.1 diagnostic** retained actual public decisions and complete candidate scores. The controlled Witch third-key example, Labwork window checks and pure public-input replays are recorded separately; they do not measure natural-game error frequency. The fixed comparison design is **96 development + 384 confirmation games** against frozen 0.6.1, comparing the new and old implementations of **Engine V3 and Card Effects V3** only. Derived callers can inherit the shared change, but the two-family comparison does not rerank all 89 policies or the five common menu entries.

Both fixed stages completed: **46–50 in development**, **192–192 (50.00%) in confirmation**, all natural finishes with zero technical or anomalous games. Both family-specific confirmation intervals include 50%; this study does not establish a stable overall win-rate gain, and the added evaluation has a measurable decision-time cost.

See the [Chinese method and evaluation report](docs/card-lifecycle-evaluation.md) and [public evidence summary](docs/evidence/card-lifecycle-2026-11-18.json) for scope and final comparison results. Local fixes and passing regressions do not establish a stable win-rate gain. No new online results or Elo ratings are claimed.
<!-- card-lifecycle-062:end -->

<!-- contextual-formulas-061:start -->
### Historical 0.6.1 contextual-formula validation

0.6.1 uses current public state for supported deterministic quantities and bounded sequential projections; supported random outcomes are valued before caps and averaging. The final candidate also refreshes captured-based power and haunted dependencies when their public inputs change, while propagating unresolved captured amounts. Missing public history remains explicit uncertainty.

The full offline suite passed **483/483**, including **57** new tests. Separate independent checks passed **94** cases and **97** whole-input immutability assertions. Against 0.6.0, the fixed development primary estimate was **51–45** and confirmation was **201–183 (52.34%)**. The separate 0.5.3 reference was **102–90 (53.12%)**.

Results are not pooled. The 849 completed games from superseded candidates remain separate from the final 672 games. All final seeds were used in candidate02, so this is a repeated fixed-design comparison, not an entirely unseen holdout. See the [Chinese report](docs/contextual-formula-evaluation.md) for per-family intervals, corrected scope metadata and limits. No new online games, Elo ratings or deployment changes are claimed.
<!-- contextual-formulas-061:end -->

The bot supports the Fuzhou deployment and international TCO. Current maintenance tests focus on **Fuzhou and owned-account games**. International matchmaking against other people has been paused since 2026-11-17; the adapter and English chat configuration remain available.

Version 0.6.3 evaluates shared play opportunities and native discards. The 0.6.2 validation focuses on lifecycle valuation, public-input replay and the fixed local comparison. The 0.6.1 formula evidence retains its historical attribution. Existing server evidence includes 0.5.3 localized capture allocation and 0.5.2 preparation retirement and delivery recovery, each attributed to its actual source and scope. Current results, historical failures and server evidence are collected in the [validation record](docs/validation.md).

Managed operation targets **Linux or Linux inside WSL**, with Node.js **22.12–24.x**, Python 3 and Chromium. Native Windows and macOS supervision has not been validated.

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

`init` generates `room.gameType: "beginner"` by default. To create a casual public room, set it to `"casual"` in the unused `seat.json`, keep `room.gameFormat: "normal"`, and retain the `AI` marker in the room name. Room type is selected in configuration; see the [operation guide](docs/operations.md).

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
Control V2**. Three experimental opening policies bring the complete menu to 92 entries. All **89 registered code-policy IDs** from the predecessor remain
available, including specialist, experimental and historical entries.

Menu commands do not contact a server, open a browser or modify existing
configuration. Use `init --policy ID`, or the optional `--choose-policy`
numbered menu in an interactive TTY; these options are mutually exclusive.
An unstarted seat configuration can also set `self.codePolicy` directly.
The [strategy guide](docs/strategy-guide.md), maintained in Chinese, explains
the policies, the current seven-policy ratings dated 2026-11-18 and the historical six-policy ratings dated 2026-11-13.

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
