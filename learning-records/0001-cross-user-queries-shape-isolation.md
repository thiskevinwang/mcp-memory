# Cross-user queries are an eventual product requirement

The user stated that cross-user memory queries must eventually be possible, and
challenged the per-user hashed namespace as the wrong isolation boundary. This
matters because it rules out teaching namespaces as the settled design and makes
write-time metadata schema (ownerId, visibility) the critical near-term topic:
Vectorize metadata indexes are non-retroactive and indexes can't be enumerated,
so schema decisions are one-way doors.

**Implications**: Next lessons should cover the namespace-vs-metadata-filter
tradeoff (fan-out sharing vs. global ranking), the "move the hash into metadata"
migration strategy, and single-choke-point application-layer isolation with
tests. Watch for mission drift: the user's goal may be broader than the current
MISSION.md ("small and safe, test instance") — confirm before updating.
