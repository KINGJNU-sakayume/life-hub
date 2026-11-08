# Roadmap

- **P0 — public repository foundation (this PR)**: threat boundaries, core candidate state machine, PALATE v1 compatibility adapter, synthetic examples, tests/CI. No remote access or real user data.
- **P1 — secure persistence and authentication**: choose private backend, owner identity and authorization, scope controls, atomic idempotent inbox, per-device cursor, durable receipt/outbox, deletion policy, encrypted backups. Document operating cost and recovery.
- **P2a — Claude connector (done in code)**: MCP endpoint + OAuth 2.1 with owner password; tools propose food candidates into the D1 inbox. See `P2_CLAUDE_CONNECTOR.md`.
- **P2b — PALATE delivery (done in code)**: PALATE pulls pending candidates over OAuth (`food:inbox`), owner approves locally, receipts/rejections flow back with retry. See `P2B_PALATE.md`. Original scope: actual ChatGPT/Claude tool invocation where supported → authenticated proposal → PALATE inbox → explicit approval → confirmed receipt → audit and retry tests, including iPhone Safari.
- **P3 — broader adapters** (켜켜이 done in code, see `P3_KYEOKYEOI.md`): achievement activity vs diary content distinction; letterbookxd reading work/edition/volume resolution; AniMan progress; sub verified station visits; kyeokyeoi confirmed memories/visits; potcast reviews and scopes; Diaryroulette today mission lookup. Add one site at a time with its domain tests.
- **P4 — conversational convenience**: safe commands, status/replay visibility, optional scheduled daily Diaryroulette prompts and supported cross-app semantic links.
- **P6 — device sync** (Hub side deployed, apps implemented): see `P6_SYNC.md`.
- **P7 — board API** (Hub side B1–B5 deployed; all nine apps upload tiles): apps upload board tiles, the separate `board` site reads them, layout sync, approved Claude memos, roulette proposals. See `P7_BOARD.md`.
- **P8 — chunked record storage** (not designed yet).

Critical non-goal: do not publish anyone's personal data in a public repo or static Pages build.
