# Admin UI grilling session

Design interview that produced
[memory-erd.md](./memory-erd.md) and the admin UI contract.

Date: 2026-08-29. Operator: same Clerk user as `ALLOWED_USER_ID`.

This file preserves the rounds. Recommendations (`➡️`) are what the interviewer
proposed. **Settled** is what the operator chose.

## Starting request

Build a lightweight SSR admin web UI, authenticated with the same Clerk OAuth.
Manage and edit memories, including re-ranking them for relevance.

Facts on the table before round 1:

- `MemoryStore` only had `persistMemory` and `recallMemories`.
- Vectorize has no list-all.
- Similarity scores are cosine, not stored.
- `/mcp` auth is Bearer, not cookies.
- Single `ALLOWED_USER_ID`.
- Hono, no JSX.

---

## Round 1

❓ **Q1** — Who is the operator?

➡️ Same `ALLOWED_USER_ID` only.

**Settled:** Same `ALLOWED_USER_ID`.

❓ **Q2** — Browser auth, not MCP Bearer?

1. Authorization-code + httpOnly cookie session (same Clerk issuer; likely a distinct web client)
2. Paste/store a Bearer token in the browser
3. Clerk session cookies / hosted components

➡️ (1).

**Settled:** (1). Operator was not confident about the flow. Later rounds
explained: no cookie → 302 Clerk → `/admin/callback?code=` → verify `sub` →
HMAC cookie. Existing `CLERK_OAUTH_CLIENT_*` is a resource-server introspection
client; a website is an OAuth *client*.

❓ **Q3** — Catalog or query-then-edit?

1. Search-first (Vectorize only)
2. True inventory via D1

➡️ (1), because inventory is not lightweight (second datastore, dual-write,
consistency).

**Settled:** (2). Operator asked why inventory is not lightweight, then still
chose D1.

❓ **Q4** — What does “re-rank for relevance” mean?

➡️ Edit text (re-embed) plus optional integer boost/pin that recall applies.

**Settled:** Do not conflate vector similarity with relevance. Relevance is
separate metadata. Humans recall semantically similar memories; those memories
also have relevance.

❓ **Q5** — How SSR?

1. Hono `html` / form POSTs, no SPA
2. HTMX
3. React/Vite SSR

➡️ (1).

**Settled:** (1), Hono + `html`.

---

## Round 2

❓ **Q6** — Is relevance global or about this thought?

1. Global number on the memory
2. Per-query `(thought, memory)` judgements

➡️ (1).

**Settled:** (1).

❓ **Q7** — Shape of that field?

1. Integer `0–100`, `NULL` = unranked (not the same as 0)
2. `0–100`, default `50`
3. Coarse enum

➡️ (1).

**Settled:** (1). Ranking is optional and additive.

❓ **Q8** — Does MCP `recall` use it?

1. Cosine-ordered; each hit also returns `relevance`
2. Fusion re-sort
3. New `recall_ranked` tool

➡️ (1).

**Settled:** Recall should *eventually* use it. v1 fusion is out of scope
(see Q14).

❓ **Q9** — Source of truth?

1. D1 owns the record. Vectorize is the ANN index. Dual-write.
2. Dual SoT (copy into Vectorize metadata too)
3. D1 admin-only; MCP stays Vectorize-only (drift)

➡️ (1).

**Settled:** (1). Operator asked for a mermaid ERD as a repo doc.

❓ **Q10** — Clerk app for the website?

1. New confidential web client
2. Reuse existing `CLERK_OAUTH_CLIENT_ID/SECRET`

➡️ (1).

**Settled:** (2). Operator can swap values. Cost: that Clerk app must allow
authorization-code and an `/admin/callback` redirect. Same secret, different
role.

❓ **Q11** — Session storage?

1. Signed httpOnly cookie (`userId` + expiry). No session table.
2. Opaque session id in cookie, row in D1

➡️ (1).

**Settled:** (1). Secure and simple.

❓ **Q12** — Admin verbs?

1. List/filter, edit text, edit relevance, delete. No create in admin.
2. Same plus create
3. Same plus create, no delete

➡️ (1).

**Settled:** (1).

❓ **Q13** — How do you find a memory in admin?

1. Paginated D1 list + substring filter
2. (1) plus a vector-search box
3. Vector search only

➡️ (2).

**Settled:** (2). Admin should reuse original similarity search.

---

## Round 3

❓ **Q14** — v1 MCP `recall`

1. Unchanged: cosine order, Vectorize metadata text, no `relevance` field
2. Additive now: hydrate D1, include `relevance: number | null`
3. Fuse now

➡️ (2).

**Settled:** (1).

❓ **Q15** — ERD (first draft had `MEMORY` plus a `VECTOR` box with namespace
and denormalized text)

➡️ Keep as drawn.

**Settled:** Move namespace to the D1 layer so the vector layer stays dumber
(easier to swap vector stores). Later reversed in part (see Q20–Q21).

❓ **Q16** — Dual-write failure

1. D1 first, then Vectorize; compensating D1 rollback
2. Vectorize first, then D1
3. Best-effort, no compensate

➡️ (1).

**Settled:** (1). Operator wanted the dual-write to be atomic and thought D1
transactions would make that easy. Fact recorded: a D1 transaction cannot
include Vectorize.

❓ **Q17** — Cookie package

1. New `ADMIN_SESSION_SECRET` · HMAC cookie · 24h · `HttpOnly; Secure; SameSite=Lax` · POST Origin check · `/admin/logout`
2. Sign with `CLERK_SECRET_KEY`
3. (1) but 7-day expiry

➡️ (1).

**Settled:** (1). Logout later punted (Q29).

❓ **Q18** — Text edit invariants

1. Same `id`, `created_at`, `relevance`; bump `updated_at`; re-embed
2. Clear `relevance` on text edit
3. New id

➡️ (1).

**Settled:** (1).

❓ **Q19** — Reuse similarity search

1. Admin search calls `memoryStore.recallMemories()`, then joins D1
2. Copy Vectorize query code into the admin route
3. D1 substring only

➡️ (1).

**Settled:** Ideally (1), implicated by Q15.

---

## Round 4

Corrections on the table:

- D1 `BEGIN` does not cover Vectorize.
- A fully dumb vector store (`{id, values}` only) forces MCP `recall` to join
  D1, which fights Q14.

❓ **Q20** — What does the vector store hold?

1. `{ id, values }` only
2. Keep Vectorize metadata (`text`, `createdAt`) so MCP can run if D1 is down
3. Keep Vectorize `namespace` for ANN isolation, also store `user_id` in D1

➡️ (1), given Q15.

**Settled:** (2). Operator had been off about making vectors fully dumb.
Vector.namespace enables ANN isolation — kept as **adapter-private** (Q21),
not a D1 column.

❓ **Q21** — “Move namespace to D1” means what?

1. D1 column `user_id` only. Hash/namespace is adapter-private.
2. D1 stores `user_id` and `namespace`
3. D1 stores `namespace` instead of `user_id`

➡️ (1).

**Settled:** (1).

❓ **Q22** — Reinterpret Q14 given Q20 (first ask)

1. MCP response schema unchanged; internals hydrate D1
2. Do not touch `recallMemories` internals (requires Q20=2)
3. MCP `recall` returns `relevance` now

➡️ (1) at first ask; recommendation flipped after Q20=2.

**Settled:** Operator forgot the context. Re-asked in round 5.

❓ **Q23** — Least dishonest “atomic” dual-write

1. Compensation (no extra table)
2. Transactional outbox + replay
3. Pretend D1 `BEGIN` covers Vectorize

➡️ (1).

**Settled:** (1).

---

## Round 5

❓ **Q22** (re-ask) — MCP `recall` internals (v1)

1. Do not change `recallMemories`. Admin search calls it, then D1 lookup.
2. Always join D1 inside `recallMemories`.
3. MCP `recall` returns `relevance` now.

➡️ (1).

**Settled:** (1).

❓ **Q24** — Old Vectorize rows are invisible to D1

1. Forward-only catalog
2. Read-repair on recall/admin search hits
3. Lossy harvest job

➡️ (2).

**Settled:** (2), then narrowed in Q28.

❓ **Q25** — Who writes D1?

1. MCP `remember`, admin text/relevance edits, admin delete — all dual-write. No admin create.
2. Admin writes D1; MCP `remember` stays Vectorize-only
3. Mixed (drift)

➡️ (1).

**Settled:** (1).

❓ **Q26** — Login UX

1. Auto 302 to Clerk
2. Login page with a button
3. Auto-redirect plus visible logout

➡️ (3) = (1) + logout.

**Settled:** (3), with uncertainty about logout. See Q29.

❓ **Q27** — Admin surface package

D1 list, `?search=` vector path, per-row edit/delete, 50/page, POST + Origin,
tiny inline CSS, search text from D1 if present.

➡️ Take the package.

**Settled:** D1 list and `?search=`. Edits/delete remain from Q12.

---

## Round 6

Q22 vs Q24: read-repair on MCP `recall` would write on the read path.

❓ **Q28** — Where does read-repair run?

1. Admin only, after `recallMemories` on `GET /admin?search=`
2. Best-effort in the MCP `recall` handler after `recallMemories`
3. Inside `recallMemories`

➡️ (1).

**Settled:** (1). Nearly no rows; read-repair is not critical and will not be
common.

❓ **Q29** — Logout

1. Drop it
2. Keep a small logout link

➡️ (1).

**Settled:** Punt. Add later if needed.

---

## Locked picture (operator confirmed)

- Operator: `ALLOWED_USER_ID` only.
- Auth: authorization-code, HMAC cookie, 24h, `ADMIN_SESSION_SECRET`, Origin
  check on POST. No logout in this build.
- D1 SoT for the record. Vectorize ANN + metadata so MCP `recall` works if D1
  is down. Namespace is Cloudflare-adapter-private.
- Relevance: global integer `0–100`, `NULL` = unranked, optional and additive.
  MCP `recall` v1 unchanged (no `relevance`, no fusion).
- Writes: D1 first, then Vectorize; compensate on Vectorize throw. Relevance
  edit is D1-only. Text edit keeps `id`, `created_at`, `relevance`.
- Admin: Hono `html`. `GET /admin` D1 list. `GET /admin?search=` reuses
  `recallMemories` then D1 join. Read-repair on admin search hits only.
  Edit text, edit relevance, delete. No create.
