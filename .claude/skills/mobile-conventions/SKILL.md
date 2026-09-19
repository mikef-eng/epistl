---
name: mobile-conventions
description: Conventions and moon commands for apps/mobile (Expo + RN + NativeWind). Preloaded into mobile-dev.
---

# Mobile lane conventions

## Moon commands (from repo root; moon loads `.env`)

```bash
moon run mobile:lint
moon run mobile:typecheck
moon run mobile:test
moon run mobile:db-generate   # after changing apps/mobile/src/storage/schema.ts
moon run mobile:start         # long-running Metro
```

Never substitute raw `npm` for lint/typecheck/test. Run `npm install` inside `apps/mobile` only when adding deps (that itself needs its own atomic issue).

## Layout

- `apps/mobile/src/screens/` — screens (JSX + NativeWind `className`)
- `apps/mobile/src/navigation/` — navigators
- `apps/mobile/src/api/`, `storage/`, `transport/`, `crypto/`, `inbox/`, `settings/`
- `apps/mobile/modules/quic-relay-client/` — **native-dev** lane, not this one
- `apps/mobile/src/crypto/**` — crypto gate; follow `pqc-crypto-change`

## Conventions

- Styling: NativeWind (`className` / Tailwind), not StyleSheet-by-default.
- Local DB: Drizzle + expo-sqlite (`docs/decisions/0012-...`). Schema in `src/storage/schema.ts`.
- Network state: TanStack Store (`docs/decisions/0009-...`) — `transport/store.ts`, `inbox/`.
- Prefer custom themed nav chrome over stock React Navigation header/tab styling when touching chrome.
- Expo SDK docs: use the version pinned in `apps/mobile` (see `apps/mobile/CLAUDE.md`).

## See also

`docs/architecture/overview.md` (Frontend, Transport). Shared invariants live in `AGENTS.md`.
