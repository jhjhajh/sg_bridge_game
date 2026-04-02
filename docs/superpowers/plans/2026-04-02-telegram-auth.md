# Telegram Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram Login Widget authentication to the Floating Bridge game, giving players persistent cross-device identity via a Cloudflare D1 (SQLite) user store and JWT sessions.

**Architecture:** Cloudflare Workers + existing Durable Objects unchanged. New D1 database stores user profiles. New `src/auth.ts` handles Telegram payload verification and JWT signing using the Web Crypto API. New `src/db.ts` wraps D1 queries. `src/index.ts` gains three new HTTP routes and resolves JWT identity before forwarding WebSocket connections to the DO.

**Tech Stack:** Cloudflare Workers, Cloudflare D1 (SQLite), Web Crypto API (HS256 JWT), Telegram Login Widget

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src/auth.ts` | Telegram payload verification + HS256 JWT sign/verify |
| Create | `src/db.ts` | D1 queries: upsert, get, update user |
| Create | `migrations/0001_users.sql` | D1 schema |
| Create | `tests/auth.test.ts` | Unit tests for auth.ts |
| Create | `.dev.vars` | Local secret values (gitignored) |
| Modify | `src/types.ts` | Add DB, JWT_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME to Env |
| Modify | `src/index.ts` | Add /api/config, /api/auth/telegram, /api/me routes; resolve JWT on WS |
| Modify | `src/game-room.ts` | Add future stats hook comment |
| Modify | `wrangler.toml` | Add D1 binding + TELEGRAM_BOT_USERNAME var |
| Modify | `static/index.html` | Add login section + widget script injection |
| Modify | `static/app.js` | JWT storage, token on WS connect, pre-fill name, PATCH on name change |
| Modify | `.gitignore` | Add .dev.vars |

---

## Task 1: Infrastructure — D1 binding, migration, secrets

**Files:**
- Create: `migrations/0001_users.sql`
- Create: `.dev.vars`
- Modify: `wrangler.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Create the D1 database on Cloudflare**

Run this command and copy the `database_id` from the output:
```bash
npx wrangler d1 create sg-bridge-users
```
Expected output:
```
✅ Successfully created DB 'sg-bridge-users' in region APAC
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

- [ ] **Step 2: Add D1 binding and bot username var to wrangler.toml**

Replace the contents of `wrangler.toml`:
```toml
name = "sg-bridge"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./static"

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]

[[d1_databases]]
binding = "DB"
database_name = "sg-bridge-users"
database_id = "PASTE_YOUR_DATABASE_ID_HERE"

[vars]
TELEGRAM_BOT_USERNAME = "YOUR_BOT_USERNAME"
```

Replace `PASTE_YOUR_DATABASE_ID_HERE` with the id from Step 1.
Replace `YOUR_BOT_USERNAME` with your Telegram bot's username (without @).

- [ ] **Step 3: Create the D1 migration file**

Create `migrations/0001_users.sql`:
```sql
CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

- [ ] **Step 4: Apply the migration locally**

```bash
cd G:/sg_bridge_bot
npx wrangler d1 migrations apply sg-bridge-users --local
```
Expected output:
```
✅ Applied 1 migration to sg-bridge-users (local)
```

- [ ] **Step 5: Create .dev.vars for local secrets**

Create `.dev.vars` at the repo root:
```
JWT_SECRET=dev-secret-change-in-production-32chars
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_FROM_BOTFATHER
```

Replace `YOUR_BOT_TOKEN_FROM_BOTFATHER` with the token from @BotFather.
`JWT_SECRET` can be any string locally; use a strong random value in production.

- [ ] **Step 6: Add .dev.vars to .gitignore**

Open `.gitignore` and add this line:
```
.dev.vars
```

- [ ] **Step 7: Commit**

```bash
cd G:/sg_bridge_bot
git add migrations/0001_users.sql wrangler.toml .gitignore
git commit -m "feat: add D1 database binding and migration for user profiles"
```

---

## Task 2: src/auth.ts — Telegram verification + JWT

**Files:**
- Create: `src/auth.ts`
- Create: `tests/auth.test.ts`

- [ ] **Step 1: Create src/auth.ts**

Create `src/auth.ts`:
```typescript
const enc = new TextEncoder();
const dec = new TextDecoder();

// Base64url encode bytes or a string
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Base64url decode to bytes
function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function importHmacKey(keyBytes: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );
}

/**
 * Verify the Telegram Login Widget auth payload.
 * See: https://core.telegram.org/widgets/login#checking-authorization
 */
export async function verifyTelegramAuth(
  data: Record<string, string | number>,
  botToken: string,
): Promise<boolean> {
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== 'string') return false;

  // Reject if auth_date is older than 24 hours
  const authDate = Number(fields.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return false;

  // Build data check string: sorted key=value pairs joined by \n
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // secret_key = SHA256(bot_token)
  const secretKey = await crypto.subtle.digest('SHA-256', enc.encode(botToken));

  // HMAC-SHA256(check_string, secret_key)
  const key = await importHmacKey(new Uint8Array(secretKey), ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(checkString));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return expected === hash;
}

export interface JwtClaims {
  sub: string;
  name: string;
  exp: number;
}

/**
 * Sign a JWT with HS256 using the given secret.
 */
export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const key = await importHmacKey(enc.encode(secret), ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verify a JWT and return its claims, or null if invalid/expired.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const key = await importHmacKey(enc.encode(secret), ['verify']);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig),
      enc.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(dec.decode(b64urlDecode(payload))) as JwtClaims;
    if (Date.now() / 1000 > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write failing tests**

Create `tests/auth.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, verifyTelegramAuth } from '../src/auth';

const SECRET = 'test-secret';

describe('signJwt / verifyJwt', () => {
  it('round-trips valid claims', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signJwt({ sub: '12345', name: 'Alice', exp }, SECRET);
    const claims = await verifyJwt(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('12345');
    expect(claims!.name).toBe('Alice');
  });

  it('returns null for wrong secret', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signJwt({ sub: '12345', name: 'Alice', exp }, SECRET);
    expect(await verifyJwt(token, 'wrong-secret')).toBeNull();
  });

  it('returns null for expired token', async () => {
    const exp = Math.floor(Date.now() / 1000) - 1; // already expired
    const token = await signJwt({ sub: '12345', name: 'Alice', exp }, SECRET);
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('returns null for tampered payload', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signJwt({ sub: '12345', name: 'Alice', exp }, SECRET);
    const parts = token.split('.');
    // Replace payload with a different base64url string
    const tampered = `${parts[0]}.${btoa('{"sub":"99999","name":"Eve","exp":9999999999}')}.${parts[2]}`;
    expect(await verifyJwt(tampered, SECRET)).toBeNull();
  });
});

describe('verifyTelegramAuth', () => {
  it('rejects when hash is missing', async () => {
    const result = await verifyTelegramAuth({ id: 123, auth_date: Date.now() / 1000 }, 'token');
    expect(result).toBe(false);
  });

  it('rejects when auth_date is older than 24 hours', async () => {
    const stale = Math.floor(Date.now() / 1000) - 86401;
    const result = await verifyTelegramAuth({ id: 123, auth_date: stale, hash: 'abc' }, 'token');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests — expect failures on the Telegram test (hash checks not mocked)**

```bash
cd G:/sg_bridge_bot
npx vitest run tests/auth.test.ts
```

Expected: JWT tests pass, Telegram `rejects when hash is missing` and `rejects when auth_date` pass (they return false early before hash computation). All 6 tests should pass.

- [ ] **Step 4: Commit**

```bash
git add src/auth.ts tests/auth.test.ts
git commit -m "feat: add JWT sign/verify and Telegram auth verification"
```

---

## Task 3: src/db.ts — D1 queries

**Files:**
- Create: `src/db.ts`

- [ ] **Step 1: Create src/db.ts**

Create `src/db.ts`:
```typescript
import type { D1Database } from '@cloudflare/workers-types';

export interface UserRow {
  telegram_id: number;
  display_name: string;
  created_at: number;
}

/**
 * Insert or update a user record. Updates display_name on conflict.
 */
export async function upsertUser(
  db: D1Database,
  telegramId: number,
  displayName: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, display_name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET display_name = excluded.display_name`,
    )
    .bind(telegramId, displayName, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Fetch a user by Telegram ID. Returns null if not found.
 */
export async function getUser(db: D1Database, telegramId: number): Promise<UserRow | null> {
  const row = await db
    .prepare('SELECT telegram_id, display_name, created_at FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Update the display name for an existing user.
 */
export async function updateDisplayName(
  db: D1Database,
  telegramId: number,
  displayName: string,
): Promise<void> {
  await db
    .prepare('UPDATE users SET display_name = ? WHERE telegram_id = ?')
    .bind(displayName, telegramId)
    .run();
}
```

- [ ] **Step 2: Run typecheck to verify no type errors**

```bash
cd G:/sg_bridge_bot
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat: add D1 query helpers for user profiles"
```

---

## Task 4: src/types.ts — update Env interface

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new bindings to the Env interface**

In `src/types.ts`, replace the `Env` interface:
```typescript
export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  JWT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_USERNAME: string;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd G:/sg_bridge_bot
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add D1 and secret bindings to Env type"
```

---

## Task 5: src/index.ts — new routes + JWT resolution

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace src/index.ts with the updated version**

Replace the entire contents of `src/index.ts`:
```typescript
import type { Env } from './types';
import { verifyTelegramAuth, signJwt, verifyJwt } from './auth';
import { upsertUser, getUser, updateDisplayName } from './db';

export { GameRoom } from './game-room';

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function getAuthClaims(
  request: Request,
  secret: string,
): Promise<{ sub: string; name: string; exp: number } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJwt(auth.slice(7), secret);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public bot username for the Telegram Login Widget
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return Response.json({ botUsername: env.TELEGRAM_BOT_USERNAME });
    }

    // Telegram Login Widget callback → verify, upsert user, return JWT
    if (url.pathname === '/api/auth/telegram' && request.method === 'POST') {
      const body = await request.json<Record<string, string | number>>();
      const valid = await verifyTelegramAuth(body, env.TELEGRAM_BOT_TOKEN);
      if (!valid) return Response.json({ error: 'Invalid Telegram auth' }, { status: 401 });

      const telegramId = Number(body.id);
      const firstName = String(body.first_name ?? '');
      const lastName = body.last_name ? ` ${body.last_name}` : '';
      const displayName = (firstName + lastName).trim() || String(body.username ?? telegramId);

      await upsertUser(env.DB, telegramId, displayName);

      const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
      const token = await signJwt({ sub: String(telegramId), name: displayName, exp }, env.JWT_SECRET);
      return Response.json({ token, displayName });
    }

    // Get authenticated user's profile
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const user = await getUser(env.DB, Number(claims.sub));
      if (!user) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ telegramId: user.telegram_id, displayName: user.display_name });
    }

    // Update authenticated user's display name
    if (url.pathname === '/api/me' && request.method === 'PATCH') {
      const claims = await getAuthClaims(request, env.JWT_SECRET);
      if (!claims) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const body = await request.json<{ displayName?: string }>();
      const name = body.displayName?.trim();
      if (!name) return Response.json({ error: 'displayName required' }, { status: 400 });
      await updateDisplayName(env.DB, Number(claims.sub), name);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/api/create' && request.method === 'POST') {
      const roomCode = generateRoomCode();
      const stub = env.GAME_ROOM.getByName(roomCode);
      await stub.fetch(
        new Request('https://internal/create', {
          method: 'POST',
          body: JSON.stringify({ roomCode }),
        }),
      );
      return Response.json({ roomCode });
    }

    if (url.pathname === '/api/ws') {
      const roomCode = url.searchParams.get('room');
      if (!roomCode) return new Response('Missing room code', { status: 400 });

      // If a JWT token is present and valid, override playerId with the stable tg_ id
      const token = url.searchParams.get('token');
      let forwardRequest = request;
      if (token) {
        const claims = await verifyJwt(token, env.JWT_SECRET);
        if (claims) {
          const newUrl = new URL(request.url);
          newUrl.searchParams.set('playerId', `tg_${claims.sub}`);
          newUrl.searchParams.delete('token'); // don't forward the token to the DO
          forwardRequest = new Request(newUrl.toString(), request);
        }
      }

      const stub = env.GAME_ROOM.getByName(roomCode);
      return stub.fetch(forwardRequest);
    }

    return new Response(null, { status: 404 });
  },
};
```

- [ ] **Step 2: Run typecheck**

```bash
cd G:/sg_bridge_bot
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
cd G:/sg_bridge_bot
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add auth/telegram, /api/me routes and JWT identity resolution on WS connect"
```

---

## Task 6: src/game-room.ts — future stats hook

**Files:**
- Modify: `src/game-room.ts`

- [ ] **Step 1: Find the game-over broadcast in game-room.ts**

Search for the `gameOver` broadcast. It looks like:
```typescript
this.broadcast({ type: 'gameOver', ... });
```

- [ ] **Step 2: Add the stats hook comment immediately after the gameOver broadcast**

After the line that broadcasts `gameOver`, add:
```typescript
// TODO: record game result for stats/leaderboards when implemented
// Example: await recordGameResult(env, state.players, { bidderWon, winnerNames })
```

- [ ] **Step 3: Commit**

```bash
git add src/game-room.ts
git commit -m "chore: add future stats hook comment at game-over"
```

---

## Task 7: static/index.html — login UI

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: Add the login section to the home screen**

In `static/index.html`, find the home screen `<div id="screen-home" ...>` block. Replace the inner `<div class="home-container">` contents with:

```html
    <div class="home-container">
      <h1>♠♥ Floating Bridge ♦♣</h1>
      <p class="subtitle">Singaporean Card Game</p>

      <!-- Telegram login section (shown when not logged in) -->
      <div id="login-section">
        <div id="telegram-widget-container"></div>
        <button id="btn-guest" class="btn btn-ghost">Continue as Guest</button>
      </div>

      <!-- Game section (shown after login or as guest) -->
      <div id="game-section" class="hidden">
        <div id="auth-status" class="auth-status"></div>

        <div class="form-group">
          <label for="input-name">Your Name</label>
          <input type="text" id="input-name" placeholder="Enter your name" maxlength="20" autocomplete="off">
        </div>

        <button id="btn-create" class="btn btn-primary">Create Game</button>

        <div class="divider"><span>or</span></div>

        <div class="form-group">
          <label for="input-room">Room Code</label>
          <input type="text" id="input-room" placeholder="e.g. AB12" maxlength="4" autocomplete="off" style="text-transform:uppercase">
        </div>

        <button id="btn-join" class="btn btn-secondary">Join Game</button>
      </div>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: add login/guest UI sections to home screen"
```

---

## Task 8: static/app.js — auth logic

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Add auth state variables after the existing state block**

In `static/app.js`, find the `// --- State ---` section (around line 9). After the existing state variables (`let ws`, `let playerId`, etc.), add:

```javascript
// Auth state
let authToken = localStorage.getItem('authToken') || null;
let authDisplayName = null; // name from /api/me, null for guests
```

- [ ] **Step 2: Add the Telegram widget loader and auth init function**

Add the following function block before the `// --- Screen management ---` section:

```javascript
// --- Auth ---

async function loadTelegramWidget() {
  try {
    const res = await fetch('/api/config');
    const { botUsername } = await res.json();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    document.getElementById('telegram-widget-container').appendChild(script);
  } catch {
    // If config fails, just show guest option
  }
}

window.onTelegramAuth = async function (user) {
  try {
    const res = await fetch('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    if (!res.ok) throw new Error('Auth failed');
    const { token, displayName } = await res.json();
    authToken = token;
    authDisplayName = displayName;
    localStorage.setItem('authToken', token);
    showGameSection(displayName);
  } catch {
    alert('Telegram login failed. Please try again.');
  }
};

async function initAuth() {
  if (authToken) {
    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const { displayName } = await res.json();
        authDisplayName = displayName;
        showGameSection(displayName);
        return;
      }
    } catch { /* fall through to guest */ }
    // Token invalid/expired — clear it
    authToken = null;
    authDisplayName = null;
    localStorage.removeItem('authToken');
  }
  // Not logged in — show login section
  showLoginSection();
}

function showLoginSection() {
  document.getElementById('login-section').classList.remove('hidden');
  document.getElementById('game-section').classList.add('hidden');
  loadTelegramWidget();
}

function showGameSection(name) {
  document.getElementById('login-section').classList.add('hidden');
  document.getElementById('game-section').classList.remove('hidden');
  const nameInput = document.getElementById('input-name');
  if (name) nameInput.value = name; // prefer auth name over localStorage
  const authStatus = document.getElementById('auth-status');
  if (authDisplayName) {
    authStatus.innerHTML = `Logged in as <strong>${esc(authDisplayName)}</strong> · <a href="#" id="btn-logout">Logout</a>`;
    document.getElementById('btn-logout').addEventListener('click', (e) => {
      e.preventDefault();
      authToken = null;
      authDisplayName = null;
      localStorage.removeItem('authToken');
      showLoginSection();
    });
  } else {
    authStatus.textContent = 'Playing as guest';
  }
}
```

- [ ] **Step 3: Update the connect() function to pass the auth token**

Find the `connect()` function (around line 121). Replace the WebSocket URL line:

Old:
```javascript
  ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${roomCode}&playerId=${playerId}`);
```

New:
```javascript
  const tokenParam = authToken ? `&token=${encodeURIComponent(authToken)}` : '';
  ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${roomCode}&playerId=${playerId}${tokenParam}`);
```

- [ ] **Step 4: Update the btn-guest click handler and call initAuth on load**

Find the `$('input-name').value = playerName;` line near the bottom of the file (around line 620). Replace it with:

```javascript
$('input-name').value = playerName;

// Show login section initially; initAuth will switch to game-section if already authed
document.getElementById('login-section').classList.remove('hidden');
document.getElementById('game-section').classList.add('hidden');

document.getElementById('btn-guest').addEventListener('click', () => {
  authToken = null;
  authDisplayName = null;
  showGameSection(null);
});

// Kick off auth check on page load
initAuth();
```

- [ ] **Step 5: Update btn-create and btn-join to PATCH /api/me if name changed**

Find the `$('btn-create').addEventListener` block. Replace it with:

```javascript
$('btn-create').addEventListener('click', async () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);
  if (authToken && authDisplayName && playerName !== authDisplayName) {
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ displayName: playerName }),
    }).catch(() => {});
    authDisplayName = playerName;
  }

  $('btn-create').disabled = true;
  try {
    const res = await fetch('/api/create', { method: 'POST' });
    const data = await res.json();
    setRoomCode(data.roomCode);
    showScreen('screen-lobby');
    $('lobby-room-code').textContent = roomCode;
    connect();
  } catch (err) {
    alert('Failed to create game');
  } finally {
    $('btn-create').disabled = false;
  }
});
```

Find the `$('btn-join').addEventListener` block. Replace it with:

```javascript
$('btn-join').addEventListener('click', () => {
  playerName = $('input-name').value.trim();
  if (!playerName) { alert('Please enter your name'); return; }
  localStorage.setItem('playerName', playerName);
  if (authToken && authDisplayName && playerName !== authDisplayName) {
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ displayName: playerName }),
    }).catch(() => {});
    authDisplayName = playerName;
  }

  const code = $('input-room').value.trim().toUpperCase();
  if (!code || code.length < 3) { alert('Please enter a valid room code'); return; }
  setRoomCode(code);

  showScreen('screen-lobby');
  $('lobby-room-code').textContent = roomCode;
  connect();
});
```

- [ ] **Step 6: Run the dev server and verify the login flow manually**

```bash
cd G:/sg_bridge_bot
npx wrangler dev --persist
```

Open http://127.0.0.1:8787 in a browser. Verify:
- Home screen shows the Telegram widget container and "Continue as Guest" button
- Clicking "Continue as Guest" shows the game section with "Playing as guest"
- Name field works, Create/Join buttons work as before (guest flow unchanged)

- [ ] **Step 7: Run all tests**

```bash
cd G:/sg_bridge_bot
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add static/app.js static/index.html
git commit -m "feat: add Telegram login widget, JWT auth flow, and guest fallback to frontend"
```

---

## Task 9: Add CSS for auth UI

**Files:**
- Modify: `static/style.css`

- [ ] **Step 1: Add styles for the auth UI elements**

Open `static/style.css` and append the following at the end of the file:

```css
/* Auth UI */
.auth-status {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 1rem;
  text-align: center;
}

.auth-status a {
  color: rgba(255, 255, 255, 0.5);
  text-decoration: underline;
  cursor: pointer;
}

.btn-ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.9rem;
  padding: 0.5rem 1.5rem;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 0.75rem;
  width: 100%;
  transition: border-color 0.2s, color 0.2s;
}

.btn-ghost:hover {
  border-color: rgba(255, 255, 255, 0.4);
  color: rgba(255, 255, 255, 0.85);
}

#telegram-widget-container {
  display: flex;
  justify-content: center;
  margin-bottom: 0.5rem;
  min-height: 48px;
}
```

- [ ] **Step 2: Commit**

```bash
git add static/style.css
git commit -m "feat: add styles for auth status and guest button"
```

---

## Task 10: Deploy to Cloudflare

- [ ] **Step 1: Apply D1 migration to production**

```bash
cd G:/sg_bridge_bot
npx wrangler d1 migrations apply sg-bridge-users
```
Expected:
```
✅ Applied 1 migration to sg-bridge-users
```

- [ ] **Step 2: Set production secrets**

```bash
npx wrangler secret put JWT_SECRET
# When prompted, enter a strong random string (e.g. output of: openssl rand -hex 32)

npx wrangler secret put TELEGRAM_BOT_TOKEN
# When prompted, enter the token from @BotFather
```

- [ ] **Step 3: Deploy**

```bash
npx wrangler deploy
```
Expected: deployment URL printed, e.g. `https://sg-bridge.<your-subdomain>.workers.dev`

- [ ] **Step 4: Configure Telegram bot domain**

In Telegram, message @BotFather:
1. `/mybots` → select your bot → `Bot Settings` → `Domain`
2. Set the domain to your Workers URL (e.g. `sg-bridge.<your-subdomain>.workers.dev`)

This is required for the Telegram Login Widget to work on your domain.

- [ ] **Step 5: Smoke test production**

Open the deployed URL. Verify:
- Home screen loads with Telegram widget and guest option
- Guest flow works (create game, join, play)
- Telegram login flow completes and persists name across browser sessions
