# Validation and compatibility

This is the initial standalone public package, version 0.1.0. The checks below were actually executed on 2026-11-16. They validate the extracted package; they do not establish a live win rate or certify every current Keyteki/TCO deployment.

## Executed release checks

The validation host ran Linux inside WSL, Node.js 22.22.3 and Python 3.12.3. Dependencies were installed from this package's own lockfile, including Playwright 1.59.1 and TypeScript 5.9.3. No global browser helper or private game engine was used by the package.

| Check | Actual result |
| --- | --- |
| Independent TypeScript build | Passed; strict type checking and no emit on compiler errors. |
| `npm test` | **181 passed, 0 failed, 0 skipped, 0 cancelled**. Includes the build. |
| Real local Chromium smoke | Passed with sandbox enabled, fresh profile and separate package registry. |
| Runtime freeze | Passed; 772 package/dependency files and 307 external execution/resource files were bound. |
| Frozen CLI | Help, initialization, offline preflight, campaign preparation and runtime verification passed. Status before first start correctly returned `CAMPAIGN_NOT_STARTED`. |
| Live games for this extraction | **0**. No server login or public game was started during these checks. |

The full suite ran at 10:48:35 Asia/Shanghai. The final browser smoke ran at 10:51:43 and frozen CLI validation at 10:52:04. Source snapshots were stable during each run. After the full suite, only the optional browser-smoke helper received a bounded-wait/failure-cleanup correction; that exact helper was then rerun successfully. The production runtime and ordinary test inputs remained unchanged.

### What the 181 tests exercise

The suite uses synthetic observations and local transport fixtures. It covers the real adapter, policy/controller, HTTP ingress, userscript and watchdog components:

- 10 strategy/adapter tests: nonempty immutable knowledge, extension rejection, summary feature preservation, canonical serialization, offered-menu actions, hidden opponent-zone rejection, unmapped identities, ready-resource ranking and conservative unknown-rule handling.
- 22 portable runtime tests: explicit configuration, exact socket scope, browser lease/process identity, pidfd signal boundaries, CLI routing, frozen-file scope, dependency resolution changes and reviewed pre-join guard pins.
- 149 transport/watchdog cases, including parameterized cases: delayed replies, timeout versus accepted write, precise queued prefixes, duplicate receipt rejection, stale session/document identity, manual intervention, bounded reattach and reconnect, unknown sends and terminal-state handling.

Two historical test cases that depended on a private native-capture fixture or a previous deployment's implicit endpoint exception were not copied into this public suite. The published tests do not require those fixtures, and an explicit endpoint configuration now has its own positive and negative coverage.

### Real browser and process checks

`npm run test:browser` uses inline HTML and test-owned processes only. The successful run proved that:

1. Two clients can share one managed browser/profile while retaining individual leases.
2. Releasing the first client preserves the other client's page and browser process.
3. Releasing the final client confirms browser exit and removes the lease record while preserving the profile and lock inode.
4. The real pidfd signal helper rejects a changed process identity, then signals only the child created by the smoke test.

The smoke creates temporary profiles, does not log into a game service, and starts no game. Successful temporary fixtures are removed; failed fixtures remain available for diagnosis.

### Standalone runtime checks

The tested frozen runtime had its own production dependency closure and no Git directory. Its CLI generated a private 0600 empty-password template, reported that preflight had not read credential contents, and prepared a campaign without starting it.

Verification bound the actual manifest, exact allowed runtime/dependency file set, file hashes and selected Node/Python/Chromium executables. A synthetic nested-dependency substitution test confirms that adding a new higher-priority dependency copy does not silently pass the new-format verifier.

The local manifest contains installation-specific paths and is not included in the repository. [PUBLICATION.json](../PUBLICATION.json) records public validation metadata and the hashes of the validated source inputs.

### Limited migration comparison

A separate private migration check ran at 10:56:40 Asia/Shanghai. It used five hand-built observations and 15 bounded pure scoring calls, with no game constructor, transition, controller, historical frame or network request. This is separate from the 181 public tests and requires the private predecessor, so its runner is not part of this repository.

For the four modeled cases—They Tell No Tales house choice, Unity Prism house work, ready amber before ending the turn, and Divine Seal public destruction payment—the old and new evaluators returned identical complete candidate scores, reasons and selected actions on the same observation. Replacing those fixtures' knowledge with the published knowledge projection also preserved their assessments.

The fifth fixture deliberately supplied an unmodeled effect. The new evaluator withheld the deterministic forge certification, and that conservative difference was recorded as expected. These five fixtures establish only this bounded migration result. They do not establish whole-package equivalence or live playing strength.

## Compatibility boundary

| Surface | Current claim |
| --- | --- |
| Observation, action and transport adapter | Implemented against the documented/observed Keyteki reference protocol, with synthetic regression coverage. |
| Local strategy and supervision | Builds and passes the listed checks on Linux inside WSL. |
| Keyteki-derived deployment used by the predecessor | Historical live experience; it is not a new acceptance run of this extracted package. |
| Current public TCO login, lobby, deck picker and unattended play | **Not validated for this release.** A userscript URL match is not an end-to-end acceptance result. |
| Native Windows/macOS process supervision | Not claimed. Linux process identity, pidfd and kernel locks are required. |
| Card knowledge completeness | Limited scoring/recognition knowledge; partial and unknown rules remain explicit. |
| Arbitrary public capture/Veil allocation contracts | Require the operator's explicit audited local facts; historical private defaults are not included. |

Configuring a different origin does not prove its UI or server rules match the adapter. Unsupported or ambiguous bindings retain their existing stop/hold behavior. The remote server remains authoritative for legal actions and game settlement.

## Historical results are separate

The predecessor recorded 17 wins and 3 losses in 20 natural games against one fixed external opponent/deck, with one additional technical concession. That is 85% among those natural outcomes, or 17 wins in 21 started attempts if the technical concession is included.

Those results belong to the predecessor's frozen runtime. This extraction changes the knowledge representation, runtime packaging and deployment configuration. It has no new live game result and no demonstrated equivalence across every decision. The historical sample is not a general TCO win-rate estimate and should not be presented as this release's benchmark.

## Reproduce the public checks

```sh
npm ci
npm test
npm run check:package
```

For the additional real local browser smoke:

```sh
npx playwright install chromium
npm run test:browser
```

Use [the operation guide](operations.md) to initialize configuration and create a runtime snapshot. Preflight and campaign preparation are local checks; `seat run`, `seat create`, and `campaign run` are the explicit operations that can contact the configured site.

The first extraction build exposed a missing intersection-type projection, an unused stale model constant and excessive TypeScript inference for the built-in data literal. Those were fixed before the successful checks above. No failed build is counted as a pass.
