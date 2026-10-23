# Fun Central documentation

## Current guides

| Guide | Use it for |
| --- | --- |
| [Project README](../README.md) | Games, public links and getting started |
| [Architecture](architecture.md) | Hub/game/shared-service boundaries, code map, persistence and adding a game |
| [Development](development.md) | Locked dependencies, local-only configuration/login and local database setup |
| [Testing](testing.md) | Required PR runner, focused checks, local ports and honest coverage reporting |
| [Deployment](deployment.md) | Workers Builds releases, existing resources/secrets and safe migration workflow |
| [Contributor code notes](../CLAUDE.md) / [agent rules](../AGENTS.md) | Repository conventions and GitNexus requirements |

The current application is the multi-game Worker, not the root archived
Python Telegram bot. Current commands come from `package.json` and the
checked-in scripts/config. Preserve Bridge's existing backend paths/API
compatibility while adding games in their own namespaces.

## Feature context and historical evidence

These documents and their screenshots/validation results describe the work
at the time they were written. They are retained rather than rewritten as
new hub/Regicide findings. They are **not current setup instructions or proof
that the present revision passed a check**.

| Material | Context |
| --- | --- |
| [Identity recovery](identity-recovery.md) | Bridge identity/name recovery behavior and the scope of its validation; not a claim that every game uses the same client implementation |
| [Hand layout](hand-layout/README.md) | Desktop hand layout and original screenshot evidence |
| [Hand fan](hand-fan/README.md) | Curved-hand design/input investigation and integration notes |
| [Table view](table-view/README.md) | Optional 2.5D Bridge presentation and captures |
| [Combined UI](combined-ui/README.md) | Hand/selection/table-view integration evidence |
| [Card drag](card-drag/README.md) | Drag interaction work and recorded validation |
| [Chat/input](chat-input/README.md) | Chat/input review and before/after captures |
| [UI polish](ui-polish/README.md) | Table-drag/lobby polish and recorded validation |
| [Dated design specs](superpowers/specs/) | Original feature designs, including single-game auth, leaderboards and group integration |
| [Dated implementation plans](superpowers/plans/) | Historical task plans, not a current migration/release checklist |
| [Feature notes](../features/) | Dated feature/change notes and their original context |

Historical documents may refer to Bridge at `/`, former product names,
old port numbers, a single-game Telegram command menu or manual deployment
snippets. In the current app, `/` is the Fun Central hub, `/newgame` is an
inline game chooser, and releases use a PR merge to `master` and Workers
Builds. Use the current guides above for commands and resource operations;
never replay historical destructive database/reset instructions.

Root Python source, `requirements.txt`, Docker files, `start_local.sh` and
`.env.example` are archived reference material. Their presence does not add
a Python service to the current Worker deployment.
