---
name: bsky-threadcraft
description: Researches, drafts, de-AI-ifies, and red-teams bulletproof Bluesky threads (standalone explainers, quote-posts, and replies) matching Mike Paulauski's authentic voice (@mike10010100.com). Enforces strict <= 300 grapheme limits, live cached WP:AISIGNS checks, evidence-pack handoffs, and adversarial subagent auditing.
---

# Bluesky Threadcraft

This skill formalizes a fast, high-rigor pipeline for producing bulletproof, receipt-heavy, authentically voiced Bluesky threads (standalone explainers, quote-post breakdowns, or direct replies) on complex political, technical, or controversial topics.

The goal is **rigor, factual precision, and authentic voice**—never a formulaic template or canned rhetorical script.

## Pipeline Overview

```
[1. Primary Sources & Evidence Pack] ➡️ [2. Cached Mode-Matched Voice + WP:AISIGNS Prep & Draft] ➡️ [3. Deterministic lint_thread.py Pass] ➡️ [4. Red-Team Subagent Audit (TypeName="self", Zero Cold-Start)] ➡️ [5. User Approval Gate] ➡️ [6. Atomic create-thread Publish]
```

> **CRITICAL RULE — NEVER AUTO-POST WITHOUT EXPLICIT USER APPROVAL:**
> Even if the user initially says *"we should reply"* or *"let's post a thread about X,"* **NEVER** call `create-thread` or `create-post` automatically after Stage 4. Always present the final red-teamed draft (with exact grapheme counts and target `replyTo` / `quoteUri` links) and wait for explicit sign-off (e.g., *"post it"*, *"looks good, send it"*, *"ship it"*) in a subsequent turn.

---

## Bluesky MCP Quick-Reference (Do NOT Read `.json` Schema Files)

All post/thread tools on `ServerName: "bluesky"` accept **either** AT URIs (`at://did:...`) **or** `https://bsky.app/profile/.../post/...` web URLs directly—**never waste a turn calling `convert-url-to-uri` first or reading `.json` MCP schema files**:

| ToolName | Exact Arguments | Notes |
| :--- | :--- | :--- |
| `get-post-thread` | `{ uri, depth?: 6, parentHeight?: 20, maxRepliesPerNode?: 15, detail?: "compact" \| "full" }` | Pass `detail: "compact"` and `maxRepliesPerNode: 15` on viral posts to avoid truncated output files. |
| `get-posts` | `{ uris: [...], detail?: "compact" \| "full" }` | Batch-hydrates 1–25 post URLs/URIs in one call, including embeds and deleted status. |
| `get-post-quotes` | `{ uri, limit?: 50, detail?: "compact" \| "full" }` | Fetches quote-posts of a target URL/URI. |
| `get-profile` | `{ handle }` | Returns `DID`, native `Pronouns:` (when set), `Bio`, `Pinned Post:`, and `Labels:`. |
| `search-posts` | `{ query, author?, mentions?, since?, until?, domain?, url?, limit?: 50, sort?: "top" \| "latest", detail?: "compact" }` | Strict AND matching. Use `author: "handle"` + short keywords (`"pronouns"`, `"wife"`, `"husband"`, etc.). |
| `create-thread` | `{ posts: [{ text, quoteUri?, imagePaths?, imageAlts?, previewUrl?, embedPreview? }], replyTo?, rollbackOnFailure?: true }` | Atomic pre-flight validation of all posts + PDS post-flight record verification + auto-rollback. |
| `create-post` | `{ text, replyTo?, quoteUri?, imagePaths?, imageAlts?, previewUrl?, embedPreview? }` | Single-post publish (never `replyToUri`, `quotePost`, or `altTexts`). |
| `delete-post` | `{ postUri }` | Deletes by AT URI or web URL (never `uri`). |

---

## Stage 1: Primary Source Ingestion, Pronouns & Evidence Pack

Before writing a single post:
1. **Fetch Primary Context:**
   - Fetch the target post, ancestors, and author follow-ups via `get-post-thread` (`detail: "compact"`, `maxRepliesPerNode: 20`) or `public.api.bsky.app` if blocked.
   - If a video, roll call, filing, or document is cited, ingest the primary material (`yt-dlp` subtitles/frames, Clerk XML, FEC/Federal Register text) into `$SCRATCH_DIR`.
2. **Pronoun & Identity Check (Mandatory When Mentioning People):**
   - Call `get-profile` for every person/account mentioned (checks native `Pronouns:`, `Bio:`, `Labels:`, and `Pinned Post:`). If still unconfirmed, run a targeted `search-posts` (`author: "<handle>"`, query: `pronouns`) or check official bios.
   - If pronouns cannot be verified with certainty, refer to them strictly by **name/handle** or second-person **`"you"`**—never guess.
3. **Lock In Mode, Thesis & Closing Button (Never Draft a Pure Listicle):**
   - Choose mode: `explainer` (standalone breakdown), `quote` (quote-post analysis), or `reply` (direct pushback/addition).
   - **Core Thesis:** Define the single governing argument. If multiple angles are plausible after an open-ended fact-check, clarify the angle with the user first.
   - **Closing Button:** Define where the final post lands (the real-world takeaway, clincher, or why the facts matter). Never stop dead on a stray caveat or shrug.
4. **Write `$SCRATCH_DIR/evidence_pack.md` (Eliminates Subagent Cold-Start):**
   - Save a concise structured dossier in `$SCRATCH_DIR/evidence_pack.md` (even when facts came from earlier turns in the same conversation!) listing:
     - Mode, Core Thesis, Closing Button, and target `replyTo` / `quoteUri` URLs + full OP text (including OP's immediate self-replies).
     - **Pronoun Ledger:** Every referenced person -> verified pronouns + exact source (or `unverified -> name-only`).
     - **Claim-to-Receipt Map:** Every factual claim, number, and timestamp mapped to its URL, cached file path in `$SCRATCH_DIR`, and verbatim quote **including the immediately preceding and succeeding sentences**.

---

## Stage 2: Fast Cached Prep (`< 1s`) & Authentic Drafting

1. **One-Shot Parallel Prep Command (Voice Sample + Distilled Live `WP:AISIGNS`):**
   Run both cached helpers in a single command (reuses local pre-`2026-10-30` corpus cache + live-verified Wikipedia `revid` digest in `< 0.5s`, producing compact `< 18 KB` files that never hit `read_file` byte truncation):
   ```bash
   SCRATCH_DIR="<artifact_dir>/scratch" && mkdir -p "$SCRATCH_DIR" \
   && python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/sample_mike_posts.py \
     --mode <explainer|quote|reply> --output "$SCRATCH_DIR/mike_voice_sample.txt" \
   && python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/fetch_aisigns_digest.py \
     --output "$SCRATCH_DIR/wp_aisigns_digest.md"
   ```
   Read `$SCRATCH_DIR/mike_voice_sample.txt`, `$SCRATCH_DIR/wp_aisigns_digest.md`, and [references/mike-voice.md](references/mike-voice.md) in a single parallel `read_file` batch.

2. **Drafting Rules (`Hook ➡️ Receipts ➡️ Button`):**
   - **Match Mode to Context:** Open naturally for an `explainer`, `quote`, or `reply`. Never copy one-off openers (like `"TBF,"`) from a single sampled post or force a canned `"concession -> trapdoor"` formula.
   - **Post 1 (Hook & Thesis):** Anyone seeing only Post 1 in their feed should immediately grasp the point.
   - **Middle Posts (Receipts):** Advance the thesis with concrete specifics; avoid disconnected listicle bullets.
   - **Final Post (Button):** Land the plane cleanly on the core takeaway.
   - **Hard Mechanical Constraints:**
     - **Zero Em Dashes (`—` or `--`):** Use commas, colons, parentheses, or periods.
     - **Zero Emojis (including `🧵`):** Never include unless explicitly requested.
     - **Strict Limit:** Every post MUST be **`<= 300` graphemes** (and `<= 3000` UTF-8 bytes), with descriptive `imageAlts` for every attached image.

---

## Stage 3: Deterministic `lint_thread.py` Check (No Ad-Hoc Python Loops)

Save the candidate thread to `$SCRATCH_DIR/draft.json` using `create-thread`'s exact JSON schema:
```json
{
  "replyTo": "https://bsky.app/profile/...",
  "posts": [
    {
      "text": "Post 1 text...",
      "quoteUri": "https://bsky.app/profile/...",
      "imagePaths": ["/abs/path/img1.png"],
      "imageAlts": ["Exact primary-source description of img1"]
    },
    { "text": "Post 2 text..." }
  ]
}
```
Run `lint_thread.py` (uses V8 `Intl.Segmenter` for exact ATProto grapheme parity + live `wp_aisigns_rules.json` checks—**do NOT write throwaway `python3 -c` length scripts**):
```bash
python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/lint_thread.py \
  --mode <explainer|quote|reply> "$SCRATCH_DIR/draft.json"
```
Fix all `[ERROR]` items and any non-verbatim `[WARN]` AI-ism flags (triads, negative parallelisms, copulative avoidance, superficial `-ing` tails, `WP:AISIGNS` watchwords) before Stage 4.

---

## Stage 4: Subagent Red-Team Audit (`TypeName: "self"`, Zero Cold-Start)

Invoke an adversarial subagent via `invoke_subagent` with **`TypeName: "self"`** (never `research`, which lacks network/MCP access for live verification) and `Role: "Red Team Critic & Voice Auditor"`, passing the paths to `$SCRATCH_DIR/draft.json`, `$SCRATCH_DIR/evidence_pack.md`, `$SCRATCH_DIR/mike_voice_sample.txt`, `$SCRATCH_DIR/wp_aisigns_digest.md`, and [references/red-team-rubric.md](references/red-team-rubric.md):

- **Strict Read-Only External Boundary:** The subagent MUST **never** call `create-post`, `create-thread`, `delete-post`, or edit repository files—only read sources, run targeted verification queries, and write `$SCRATCH_DIR/draft_redteamed.json`.
- **Zero Cold-Start Re-Googling:** The subagent starts from `$SCRATCH_DIR/evidence_pack.md` and cached files in `$SCRATCH_DIR`. Do **not** re-search baseline facts already proven in local primary files; spend 100% of external queries trying to **break** the draft (checking adjacent roll calls, footnotes, OP follow-ups, rival definitions, visual accuracy, and pedant/troll escape hatches).
- **Proportional Depth:** Keep external checks surgical (~1–4 targeted lookups) on 1–2 post replies whose receipts are already cached locally; run deeper verification sweeps on complex multi-post explainers.
- **Single-Owner Structural Rewrite & Lint:** If the audit uncovers factual traps, an unbuttoned ending, or a stronger narrative arc, **rewrite from scratch** rather than patching clunky edits into old post boundaries, save `$SCRATCH_DIR/draft_redteamed.json`, and run `lint_thread.py` once to confirm `0` hard errors before returning.

---

## Stage 5: Mandatory User Approval Gate

1. **STOP** immediately after Stage 4 completes.
2. Present the final hardened thread copy, exact grapheme counts (`N/300`), attached images/alts, and target `replyTo` / `quoteUri` links.
3. **Wait for explicit user sign-off** before publishing anything.

---

## Stage 6: One-Call Verified Thread Publishing (Only After Approval)

Once the user approves:
- **Multi-post thread:** Publish in **one single tool call** via `create-thread` (`ServerName: "bluesky"`, `ToolName: "create-thread"`), passing `posts` and optional `replyTo` directly from the approved JSON.
- **Single post:** Publish via `create-post` (`ServerName: "bluesky"`, `ToolName: "create-post"`).
- **Confirm Post-Flight Status:** `create-thread` and `create-post` automatically validate all posts pre-flight, verify every committed PDS record (`reply.parent`, `reply.root`, and `embed` type/quote/images) post-flight, and auto-rollback on mismatch. Confirm the response reports `Post-Flight: PASS`!
  - *Fallback for stale MCP sessions:* If the running `bluesky` MCP server predates `create-thread` (or reports `Post-Flight: skipped`), publish sequentially via `create-post` and batch-verify all returned URIs in one `get-posts` call (`detail: "full"`), deleting (`delete-post`) and re-posting immediately if any `reply` or `embed` mismatched.
