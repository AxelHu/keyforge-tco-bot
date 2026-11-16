# Card knowledge and strategy boundary

This package contains an observation-based strategy, not a KeyForge referee. The remote Keyteki-compatible server supplies the legal menu and settles the actual card effects. No game constructor, authoritative transition function, hidden deck order, replay executor, rule scheduler, or replica card module is included.

## What the package keeps

The current `tactical-style-engine-v3` scoring implementation and its registered code-policy family are included. They rank actions already present in the observation. Bounded public estimates for Unity Prism, Sir Jaune, They Tell No Tales, Infurnace, public destruction/refunds, house defense, and ready-work sequencing remain strategy computations. An estimated resource change is not a real settlement or proof of a future legal action.

`src/contracts/observation.ts` defines player-view data and the evaluation input language. It has no `GameState`, engine `Frame`, settlement queue, or complete card execution instruction union. `src/shared/canonical.ts` is the original pure stable serialization function, separated from the original replay executor. Explicit `undefined` remains significant to its hashes.

The default knowledge pack contains 2,546 public card identities and a finite projection of facts used by these strategies. Public names, printed numbers, houses, types, power, armor, amber, traits, and keywords are metadata. Additional fields are explicitly whitelisted heuristic inputs or conservative guards. The compatibility name `CardDefinition` refers to that limited input contract, not an executable rules definition.

The original internal effect language has 439 distinct instruction kinds after expanding its alias and intersection branches. This contract recognizes 47 scoring or shape-recognition kinds; the central action estimator explicitly evaluates 36 of them. The other retained shapes support existing public prompt recognition, specialist estimates, or uncertainty checks. No generic interpreter can advance a game from these inputs. The source modules that implemented card rules are not distributed.

## Unmodeled content stays visible to the strategy

Generation replaced 799 unsupported effect nodes with `{kind: "unmodeled"}`. It also retained a top-level `unmodeled: true` marker on 357 card entries with additional rules outside the selected input fields. Research interpretation annotations are not published as prose; their presence also retains the unmodeled marker. Unknown instructions are not silently turned into zero effects. Array positions and conservative presence tests are preserved. If an otherwise understood effect has omitted fields, it retains its own unmodeled marker as well as the card marker; its estimate is uncertain.

For example, a two-capture continuation must reject additional unmodeled text, and refill planning must reject an unmodeled before-refill hook. The capture guard ignores only the newly introduced nonsemantic summary-feature mask; it still rejects the unmodeled marker. The adapter reports partial knowledge in its qualifications. A visible card with no identity in the knowledge pack remains unsupported; the adapter does not invent its abilities or legal actions.

These counts describe the generated package, not complete support for 2,546 cards. Known identity, partially understood text, bounded scoring support, and fully verified strategy behavior are different claims. `src/knowledge/coverage.ts` records the precise generation counts.

## Card text and legacy heuristics

The original card `summary` strings are not included, including the upstream ToC text table. Every built-in entry has the authored description “Heuristic card knowledge; printed rules text is not included.”

Twelve finite legacy text predicates still matter to code-policy fallbacks. Their boolean results are stored in a 12-bit `summaryFeatures` mask. `summaryFeature()` reads these booleans; it does not recover or encode the original prose. This preserves those predicates without shipping the card text. Names and short choice labels remain public identification or menu-binding data. Optional model consumers receive the limited authored descriptions, so model behavior is not claimed equivalent to the original full-text research setup.

## Extending the pack

`registerCardKnowledge(entries)` accepts additional owned or appropriately authorized knowledge before a session starts. Entries must pass the explicit card/effect field schema and JSON/depth limits. A duplicate or invalid pack is rejected before any of its entries is installed; existing built-in identities cannot be silently overwritten. Definitions are cloned and frozen. The adapter reads the current catalog when resolving names.

A custom knowledge pack must continue to distinguish uncertain observations from known zero effects. It may not add internal execution instructions, hidden physical identities, account data, or a replica game implementation. The extension interface is for public strategy knowledge, not authoritative rule settlement.

## Validation and performance claims

The included standalone tests use hand-built protocol/observation fixtures and the real adapter, strategy and controller. They do not start a local Game or contact a server. Build/test receipts and any private same-frame differential validation belong to the release review.

The historical 17–3 natural-game result belongs to its original frozen runtime. This extracted package has a changed knowledge representation, a separate identity, and no new live win-rate claim. Preserving scoring source does not by itself establish behavioral equivalence: differences in omitted rules, unknown handling, text features, names, or observations must be checked. Private historical decision frames are not published as fixtures.

## Deployment-specific allocation contracts

Personal deck UUIDs and historical source/runtime manifests are not included as default attestations. The generic strategy catalog no longer carries personal deck recommendations. The Tullibint strategy still identifies its exact public card composition and retains its specialized planning; it does not depend on a personal UUID.

Verified public capture and Veil allocation require explicit, once-per-process local registration through `configurePublicCaptureFacts()` or `configureVerifiedVeilFacts()` before sessions start. Registration must use the operator's audited source/runtime digests and exact public composition/physical-configuration facts. The original participant, profile, origin/frontend, complete 36-card, enhancement and source/runtime binding checks remain. Missing or mismatched local facts fail closed; no synthetic production attestation or broad server-support claim replaces the removed defaults. These registrations are local configuration and are not evidence that a public server runs the reference code.
