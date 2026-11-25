# Mission Control

A Paseo plugin for supervising many coding agents in parallel across hosts. Plugin id `mission-control`.

Status: step 0 (setup). The plugin currently contains only the Paseo adapter and a temporary hook logger.

## Layout

| Path | Runs in | Purpose |
| --- | --- | --- |
| `index.server.ts` | Daemon subprocess | Server entry. Owns all state and logic. |
| `server/paseo/adapter.ts` | Daemon subprocess | The one module that calls Paseo: hooks, settings, RPC handlers, SDK. |
| `server/log.ts` | Daemon subprocess | Plugin log (`paseo plugin logs mission-control`). |
| `server/paths.ts` | Daemon subprocess | Resolves `$PASEO_HOME/mission-control/` for state. |
| `server/debug/hook-logger.ts` | Daemon subprocess | TEMPORARY. Logs every lifecycle hook. |
| `index.client.tsx`, `client/` | Paseo app | Renders and calls RPCs only. |
| `shared/` | Both | `defineRpc` / `defineSubscription` contracts and plain values. |

## Develop

```bash
npm install
npm run typecheck
paseo plugin install "$PWD"        # first time, from this folder
paseo plugin reload mission-control  # after each change
paseo plugin logs mission-control
```

Built against Paseo 0.17.4 (`requirements.paseo` is `>=0.17.4 <0.18.0`). Check each new Paseo release before widening the range.
