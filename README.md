# Syndicate

Syndicate is a browser-playable, real-time cyberpunk crime strategy prototype. The server uses Node.js, a modular game engine, bcrypt password hashes, JWT-backed HTTP-only sessions, and Socket.IO for live chat.

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. Create an account to enter the city. For production, set `NODE_ENV=production` and provide a long random `JWT_SECRET`; production cookies are marked `Secure` and must be served over HTTPS.

## Demo

The interactive static preview is in `docs/` and is published to GitHub Pages by the `Deploy demo to GitHub Pages` workflow after it is enabled for the repository. The preview is a standalone sample; the full game requires the Node.js server described above.

Account, game, company, and chat data currently use in-memory stores. They reset when the server restarts. `db/schema.sql` defines the PostgreSQL persistence contract for a production repository implementation.

## Systems

### NPC decision-making and combat

`src/npc.js` builds candidate actions and scores them using health, wealth, threat level, district distance, faction status, reputation, and current orders. NPCs can attack players, rival NPCs, or a rival gang member; retreat, patrol, lay low, collect intelligence, join/leave/create gangs, and found companies. Combat uses explicit stats and damage rules. An NPC behavior pass runs every 30 seconds, with action cooldowns.

### Companies

`src/companies.js` handles player and NPC company registration, shares, CEO/CFO/employee roles, invitations, wages, income assets, treasury deposits, and recurring inter-company contracts. A company must be managed by its CEO/CFO to purchase assets, set wages, invite employees, or make contract offers. Contract offers need a manager on the receiving company to sign them.

Starting a company costs 500 credits. Its founder receives 60% of 1,000 shares; the treasury holds the remaining 40% at 25 credits per share. Kiosks, workshops, and data vaults generate credits each minute. Contracts transfer a negotiated amount each minute after signing. The browser has controls for founding, investing, asset purchases, invitations, wages, contracts, and company chat.

### Accounts and sessions

`src/accounts.js` validates account inputs, hashes passwords with bcryptjs, and signs/verifies HS256 JWTs. The token is held in an `HttpOnly; SameSite=Strict` cookie, with `Secure` enabled in production. Passwords are never returned to clients. The login/register interface is in `public/login.*`.

The current account service is in memory. For production, replace it with a database-backed repository and keep the same account service contract. Use the `users` and `player_profiles` tables in `db/schema.sql`. The server throttles login and registration attempts per IP and invalidates a user's sessions on logout by incrementing their session version.

### Chat

`src/chat.js` provides Socket.IO global, company, and direct channels. Company rooms and direct-message recipients are checked on the server. Messages are capped at 500 characters and lightly rate-limited. NPCs respond when addressed by name, can be directly whispered to, and broadcast selected autonomous actions to global chat.

## HTTP API

- `POST /api/register` — create an account and player profile.
- `POST /api/login` / `POST /api/logout` — start/end the HTTP-only session.
- `GET /api/me` — current account.
- `GET /api/state` — signed-in player's game view and public company roster.
- `GET /api/players` — public player directory for invites and direct messages.
- `POST /api/actions` — real-time game actions. The server selects the player from the session.
- `POST /api/companies` — found a company.
- `POST /api/companies/actions` — deposit, buy shares/assets, invite, set wages, change roles, and manage contracts.

Game actions keep the existing resource costs: attacks and battle training consume energy; gathering and production consume nerve. Energy regenerates by 5 every 15 minutes, nerve by 1 every 5 minutes, and both cap at 100.

## Game loop

The account session identifies a player for HTTP and Socket.IO. Real-time resource regeneration and NPC behavior operate on the shared world state. Company assets, payroll, and signed contracts settle each minute. Chat room access follows company membership and session identity. In a multi-instance deployment, replace the memory stores with PostgreSQL transactions and Redis/Socket.IO adapters before scaling horizontally.
