# Jrnl — web

The Jrnl journal app as a single-page app plus an API: open-to-write, the
typewriter surface, the 5-minute entry lifecycle, journals, location tagging,
inline media, and read mode's list / calendar heatmap / map.

No build step and no dependencies — plain Node (`node:sqlite`, built in since
22.5) serving ES modules as-is.

## Running it

```bash
JRNL_HOST=any node server/index.js
```

Then open <http://localhost:8787>. `JRNL_HOST` is required and has no default;
`any` accepts every `Host` header and is the local-development setting.

```bash
npm test                       # entry lifecycle suite
npm run seed -- <user> --reset # dev history for checking read mode
```

Data lives in `./data` (`jrnl.db` plus `media/`). Deleting that directory
resets everything.

## Accounts

There is no self-serve sign-up. The operator mints an **account token** for a
username and hands it over; the person who receives it picks a password.

```bash
npm run account-token ada   # token on stdout; expires in a week; deleted when used
```

Entering the token on the sign-in screen leads to **Account setup**, which
shows the name the token was minted for and asks only for a (new) password.
What that does depends on the name:

- **No account yet** — it creates one, with the default `personal` journal.
- **Account already there** — it **resets** that account: the new password
  takes effect and every session signed in under the old one is dropped.
  Journals, entries, and media are untouched.

That is also the whole password-recovery story — there is no email to send a
link to, so a forgotten password is a message to the operator and a fresh
token. Minting again for the same name retires the previous token.

Passwords must be at least 10 characters, stored as scrypt hashes. A sign-in is
exchanged for a 30-day session token the client keeps in `localStorage`.

## Deploying

One process and a SQLite file, so: one machine with a persistent disk, behind a
reverse proxy that terminates TLS. The session token is a bearer credential and
must not travel over plain HTTP.

Set `JRNL_HOST` to the public hostname. The process then refuses any request
whose `Host` header is not that name, and will not start without it — a guard
that switches itself off when a variable goes missing is not a guard. The proxy
must forward the public Host header (nginx does by default).

| Variable | |
| --- | --- |
| `JRNL_HOST` | Public hostname, or `any` for local development. Required. |
| `PORT` | Default `8787`. |
| `JRNL_DATA` | Data directory, default `./data`. Everything worth backing up. |
| `JRNL_GEO_UA` | Identifying User-Agent — set it before pointing Nominatim at a real deployment. |
| `JRNL_RATE_RPS` / `JRNL_RATE_BURST` | Global token bucket, default 30 / 80. |

Rate limiting is one bucket for the whole process with no per-client dimension:
it bounds total load but does not stop one client from spending everyone's
budget. Per-IP limiting belongs at the reverse proxy (nginx
`limit_req_zone $binary_remote_addr`), which is the layer that knows the real
client address; this process never sees it and does not trust
`X-Forwarded-For`.

### Harbor

This repo is a folder happ (`manifest.toml` at the root). Link or copy it into
your harbor apps directory as `jrnl.happ`, then:

```bash
harbor stage jrnl
harbor start jrnl
```

The published URL is `jrnl.<your-domain>`; set the `host` config to match. Data
lands in harbor's data volume. Mint the first token with the `account-token`
command against a running container, or locally with `JRNL_DATA` pointed at
that volume.

Every tunable above — plus the entry-lifecycle timings and the geocoding queue
— is a `[config]` param with the code's own default, so nothing has to be set:

```bash
harbor config jrnl                    # list them, with descriptions
harbor config jrnl --set auth_rps=2
```
