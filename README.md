# AI Terminal with Vulnerability Scanning & Patching System

A local-first SSH and SFTP client with integrated AI assistance and Linux
vulnerability scanning. Hosts, keys, split-pane terminals, file transfer,
snippets, port forwarding, and automated security auditing in one window —
everything stored on your machine, credentials sealed under a master password.

---

## Run it on localhost

### Requirements

| | |
|---|---|
| Node.js | 20.9 or newer (built and tested on 24.13) |
| npm | 10 or newer |
| Build tools | Only if npm cannot fetch a prebuilt `sqlite3` binary — Windows: `npm i -g windows-build-tools` or Visual Studio Build Tools; macOS: Xcode CLT; Linux: `build-essential` + `python3` |

### 1. Install

```bash
cd terminalai
npm install
```

### 2. Configure (optional)

```bash
cp .env.example .env.local
```

Everything has a working default. The only reason to edit it now is the AI
assistant, which needs `OPENROUTER_API_KEY`. Without a key the app runs
normally and the assistant returns a clear "not configured" message.

### 3. Start

```bash
npm run dev
```

Open **http://localhost:3000**.

`npm run dev` runs `server.js`, not `next dev`. That one process serves the UI,
the REST API and the Socket.IO terminal transport together — starting Next on
its own gives you a page with no SSH backend behind it.

### 4. First run

1. Choose a master password (8+ characters). It encrypts every credential you
   save and is never written to disk — **there is no recovery**.
2. Any hosts from the previous version are imported and encrypted automatically
   at this point.
3. **Keychain → New identity** — store a password or private key.
4. **Hosts → New host** — address, port, and the identity to use.
5. Double-click the host, or press `Ctrl+K` and start typing.

The first connection to any host shows its key fingerprint for you to verify.
Accepted keys are remembered under **Known hosts**.

Optionally, press **2FA** in the rail to put a Google Authenticator code in
front of the vault as well.

### Production mode on localhost

```bash
npm run build
npm start
```

Same URL, prebuilt assets, no dev overhead.

### Desktop app

```bash
npm run electron:dev     # run the desktop shell against a live server
npm run electron:build   # package an installer into dist/
```

`electron:build` produces NSIS on Windows, DMG on macOS, AppImage on Linux. The
packaged app picks a free port, starts the same server on loopback, and keeps
its vault in the OS user-data folder rather than inside the app bundle.

### Changing the port

```bash
PORT=4000 npm run dev              # macOS / Linux
$env:PORT=4000; npm run dev        # PowerShell
```

`HOST` defaults to `127.0.0.1` and should stay there. This process holds live
SSH sessions and binds local tunnel ports; it has no authentication of its own
because it assumes only you can reach it.

---

## What's in the box

**Host and identity vault.** Hosts organise into groups that nest to any depth,
plus tags and full-text search across both. Credentials live in a separate
keychain, so one identity can back many hosts. Passwords, private keys and
passphrases are sealed with AES-256-GCM under a key derived from your master
password via scrypt (N=32768, r=8, p=1). Sealed values never leave the server
process — the API returns only metadata like "has a key, ed25519, SHA256:…".

**Terminal.** Tabs, plus split panes in either direction, dragged to any ratio.
A split opens another channel on the *same* SSH connection rather than
re-authenticating. Per-host theme, font and size; scrollback search; clickable
links; WebGL rendering where the GPU allows, falling back quietly otherwise.

**SFTP.** A file browser beside the terminal on the same connection. Navigate,
rename, chmod, mkdir, delete; drag files in to upload. Transfers stream over
HTTP so a large file never gets base64-framed or buffered in memory.

**Snippets.** Save a command once, then run it on one pane or on every open
session at once. A host can also nominate a snippet to run at login.

**Port forwarding.** Local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`),
configured visually with a live diagram of where traffic actually goes, started
against an already-open session and shown running in the status bar.

**AI assistant.** `Ctrl+Shift+I` in any pane. Describe what you want, optionally
sharing the last 40 lines of that pane as context; the suggested command is
typed at your prompt and **not executed** — you press Enter.

**Two-factor authentication.** Works in both directions, with Google
Authenticator or any other TOTP app:

- *On the vault* — **2FA** in the rail shows a QR code to scan (with the setup
  key behind a "Can't scan it?" toggle for typing by hand), and only switches
  on after a code proves your app has it. From then on unlocking
  needs the master password **and** a current code. The secret is sealed under
  your master key, so it cannot be stripped by editing the database, and it
  moves with you when you change the master password.
- *On a server* — an identity can carry the base32 secret (or an `otpauth://`
  link) for a box running the Google Authenticator PAM module. When that server
  asks `Verification code:`, terminal.ai answers it from the vault instead of
  interrupting you. Anything it cannot answer still surfaces as a dialog, and
  a code is only ever sent once — a rejected login asks you rather than
  replaying a code the server has already burned.

**Security.** Host keys are verified on every connection and a changed key stops
the handshake with a warning. Jump hosts chain up to 5 hops.
Keyboard-interactive prompts (PAM challenges) surface as a dialog. Locking the
vault closes every live session and makes every write return 423.

### Keyboard

| | |
|---|---|
| `Ctrl+K` | Command palette / quick connect |
| `Ctrl+Shift+E` | Split right |
| `Ctrl+Shift+O` | Split down |
| `Ctrl+Shift+W` | Close pane |
| `Ctrl+Shift+F` | Search scrollback |
| `Ctrl+Shift+I` | AI assistant |

---

## Architecture

```
main.js                  Electron shell: free port, fork server.js, load it
server.js                Next + Socket.IO on one port; boots the runtime first

server/core/             CommonJS runtime, shared by both sides via globalThis
  db.js                  sqlite3 wrapper + schema
  crypto.js              scrypt KDF + AES-256-GCM envelopes
  vault.js               lock state, master key (memory only), re-keying
  repo.js                data access; the only module that decrypts
  sshManager.js          ssh2 sessions: shells, SFTP, tunnels, host-key trust
  socks5.js              SOCKS5 server for dynamic forwarding
  socketApi.js           Socket.IO event surface
  legacy.js              one-shot import of the pre-vault table

src/app/api/             REST for CRUD; SFTP transfers stream here
src/lib/                 core bridge, API helpers, socket client, store, themes
src/components/          UI
```

The runtime is pinned to `globalThis` because `server.js` loads it with plain
`require` while Next route handlers are bundled separately — without that pin
each side would get its own vault instance, and the API's would always be
locked.

### Where the data lives

| | |
|---|---|
| Development | `./connections.db` (override with `DB_PATH`) |
| Packaged | Electron `userData` — `%APPDATA%/terminal.ai` on Windows |

It is gitignored. Deleting it resets the vault and everything in it.

---

## Notes for whoever maintains this

- **Rotate the OpenRouter key.** The previous build hardcoded a live API key in
  `src/app/api/ai/route.js` as a fallback. The fallback is gone, but that key
  was in source and should be considered compromised.
- **Upgrading from the old version** happens on first unlock: each row of
  `connections` becomes a group, an identity and a host. The old table is kept
  as `connections_legacy_backup` with its plaintext secret columns nulled out,
  then the file is VACUUMed and checkpointed so the old bytes are not left in
  free pages.
- **The `-ai ` inline trigger is gone.** It tracked a guessed copy of the remote
  input line and erased it with synthetic backspaces, which corrupted the line
  under tab-completion, multi-line prompts and full-screen programs. The
  overlay replaces it and cannot desynchronise from the shell.
- **Replacing the logo**: drop your file in `public/`, set
  `NEXT_PUBLIC_BRAND_LOGO=/your-logo.svg`. Layout, sizing and every surface that
  shows the mark follow automatically.

## Troubleshooting

**`npm install` fails on sqlite3** — no prebuilt binary for your platform, so it
compiled from source and the toolchain is missing. Install the build tools from
the requirements table and retry.

**"terminal.ai runtime is not loaded"** — something started `next dev` instead
of `server.js`. Use `npm run dev`.

**Port already in use** — `PORT=4000 npm run dev`. The desktop build finds a
free port by itself.

**A tunnel will not start** — the listen port is taken. Local and dynamic
forwards bind on this machine; check what already holds the port.

**Host key warning on a server you rebuilt** — expected. Delete its entry under
**Known hosts** and reconnect to trust the new key.
