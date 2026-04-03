# Mattermost Channel Integration

Mattermost support for TinyAGI, added as a custom channel alongside Discord, Telegram, and WhatsApp.

## How It Works

The Mattermost channel is a standalone Node.js process (like the other channels) that:

1. Connects to your Mattermost server via **WebSocket** for real-time DM events
2. Enqueues incoming messages to the TinyAGI queue via the local HTTP API
3. Listens for responses via **SSE** and delivers them back as Mattermost posts
4. Supports all standard channel features: pairing, `/agent`, `/team`, `/reset`, file attachments, typing indicators

No external npm packages are required — it uses Node's native `WebSocket` and `fetch`.

## Setup

### 1. Create a Bot Account in Mattermost

1. Go to **System Console > Integrations > Bot Accounts** and enable bot accounts
2. Go to **Integrations > Bot Accounts > Add Bot Account**
3. Give it a username (e.g. `tinyagi-bot`) and role
4. Copy the **Access Token** — this is your `bot_token`

### 2. Configure settings.json

Add the Mattermost config to `~/.tinyagi/settings.json`:

```json
{
  "channels": {
    "enabled": ["mattermost"],
    "mattermost": {
      "bot_token": "your-bot-access-token",
      "url": "https://your-mattermost-server.com"
    }
  }
}
```

### 3. Start

```bash
tinyagi restart
```

Or run standalone for testing:

```bash
MATTERMOST_URL=https://mm.example.com MATTERMOST_BOT_TOKEN=xxx node ~/.tinyagi/packages/channels/dist/mattermost.js
```

### 4. Pair Your User

DM the bot in Mattermost. You'll get a pairing code. Approve it:

```bash
tinyagi pairing approve <CODE>
```

## Files Modified (vs upstream TinyAGI)

These are the files that differ from the upstream `TinyAGI/tinyagi` repo:

| File | Change |
|------|--------|
| `packages/channels/src/mattermost.ts` | **New** — full channel implementation |
| `packages/channels/package.json` | Added `dev:mattermost` and `mattermost` scripts |
| `packages/main/src/channels.ts` | Added `mattermost` to `CHANNEL_SCRIPTS` and `TOKEN_ENV_KEYS` maps; added `MATTERMOST_URL` env forwarding |
| `packages/core/src/types.ts` | Added `mattermost` to `Settings.channels` type |

## Surviving Upstream Updates

`tinyagi update` downloads a release bundle and overwrites files in `~/.tinyagi/`. Your **settings.json, database, and pairing.json are safe** (they aren't in the bundle), but the source and dist files **will be overwritten**, losing the Mattermost changes.

### After running `tinyagi update`:

```bash
# 1. Re-apply changes from your private repo
cd ~/.tinyagi
git checkout -- packages/channels/src/mattermost.ts \
                packages/channels/package.json \
                packages/main/src/channels.ts \
                packages/core/src/types.ts

# 2. Rebuild (the update overwrites dist/ too)
npm run build

# 3. Restart
tinyagi restart
```

### Alternatively, use the reapply script:

A one-liner that does the same thing:

```bash
cd ~/.tinyagi && git checkout -- . && npm run build && tinyagi restart
```

This works because your private git repo at `~/.tinyagi` tracks your customizations. After an upstream update overwrites files, `git checkout` restores them from your last commit.

### Recommended workflow for upstream updates:

1. `tinyagi stop`
2. `tinyagi update` — this overwrites files but your git history is intact
3. `cd ~/.tinyagi && git diff` — review what the update changed
4. `git checkout -- .` — restore your customizations
5. If the update changed files you also modified (merge conflicts), manually reconcile
6. `npm run build && tinyagi restart`
7. `git add -A && git commit -m "re-apply customizations after vX.Y.Z update"`
8. `git push`
