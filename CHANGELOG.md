# Changelog

## [1.0.0-alpha.1] — 2026-05-18

### v3 — Vector recall, write-time compaction, resident daemon (AGT-311 through AGT-323)

v3 is a major architectural redesign. Full design: [think-v3 project README](https://github.com/OpenThinkAi/think-cli/blob/main/docs/think-v3.md).

**Phase 0 (AGT-311):** L1/L2 schema extensions — kind, compacted_from, supersedes, topics, embedding column; v2 JSONL stays readable.

**Phase 1 (AGT-312):** Embedding pipeline — @huggingface/transformers wrapper (bge-small-en-v1.5), think reindex command.

**Phase 2 (AGT-313):** Daemon scaffold — Unix socket server, JSON-line protocol, auto-start on first CLI call, think daemon start|stop|status.

**Phase 3 (AGT-314):** Activity-based recency — stable activity_seq column, exponential-decay recency weighting in retrieval.

**Phase 4 (AGT-315):** Write commands through daemon — think sync, think retro, think event routed over socket.

**Phase 5 (AGT-316):** Write-time compaction — background queue, vector-gated triage (skips LLM when no similar candidates), compaction prompt, supersession links.

**Phase 6 (AGT-317):** Retro supersession check — async LLM-based conflict detection between retros; events accumulate unconditionally.

**Phase 7 (AGT-318):** Cross-cortex federation — parallel per-cortex queries, merged + re-ranked recall, cortex provenance in output.

**Phase 8 (AGT-319):** Sync push debounce + proxy-subscribe client — 500ms debounce on L1 writes, WebSocket subscribe client with polling fallback.

**Phase 9 (AGT-320):** Hook + MCP integration — UserPromptSubmit hook for per-prompt grounding, MCP server exposing think_recall/think_sync/think_expand; think init --hook and think init --mcp.

**Phase 10 (AGT-321):** v3 think init block — v3-aware CLAUDE.md init output with hook + MCP guidance; --hook/--mcp flags.

**Phase 11 (AGT-322):** v3 think brief — cortex-aware status report combining daemon health, recent memories, and retros; --cortex and --json flags; --kind/--topic/--since recall filters.

**Phase 12 (AGT-323):** Version bump to 1.0.0-alpha.1, README v3 overview, workflow alpha-tag fix, release/v1.0.0-alpha branch cut.

---

## [0.6.12] and earlier

See git log for v0.x history.
