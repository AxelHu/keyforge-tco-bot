# Source and attribution

The code in this repository is released by AxelHu under the MIT License in
`LICENSE`. Third-party dependencies retain their own licenses.

This package contains client-side protocol adaptation, observation-based
strategy evaluation, and process/browser supervision. It does not contain the
private project's authoritative game engine, game server, state-transition
executor, complete card-rule implementation, web game, or replay executor.
The strategy knowledge format and its supported coverage are documented in
`docs/card-knowledge.md`; it must not be confused with an authoritative rules
implementation.

## Protocol reference

The adapter was developed against the publicly documented and observed
Keyteki player protocol, including the upstream revision
`361c085bcd401c20976ee9bcc4e4e5b8c061d56c`:

https://github.com/keyteki/keyteki

That upstream application is not vendored here. Its license file and package
metadata contain different license declarations; this package does not rely
on the package metadata as permission to redistribute that application.
Any separate installation of Keyteki is governed by its own terms.

## Game names and content

KeyForge and related game names are used for identification and compatibility.
This is an unofficial project, not affiliated with or endorsed by the game
publisher or the operators of The Crucible Online. No official card artwork,
logos, complete rulebook, or bulk card-text archive is included.

No user account credentials, browser profiles, original private match views,
owned-deck collection, or private project Git history are included. Example
accounts and protocol fixtures are synthetic. Locally generated decision
journals can contain the user's own hidden hand/archive information and should
remain in the ignored runtime directory.

## Dependencies

Dependencies are installed from the package lock; their original notices are
available in the installed packages. Playwright, TypeScript and the transitive
diff-match-patch dependency use Apache-2.0;
jsondiffpatch, Socket.IO and the Node.js type declarations use MIT. Socket.IO
is used only by offline test fixtures. This repository does not redistribute a
Chromium binary; install a supported browser separately.
