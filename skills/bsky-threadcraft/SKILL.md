---
name: bsky-threadcraft
description: Researches, drafts, de-AI-ifies, renders receipt cards, and red-teams bulletproof Bluesky threads (standalone explainers, quote-posts, and replies) matching Mike Paulauski's authentic voice (@mike10010100.com). Enforces strict <= 300 grapheme limits, live cached WP:AISIGNS checks, <1s Retina receipt cards, evidence-pack handoffs, and tiered adversarial auditing.
---

# Bluesky Threadcraft

This skill formalizes a fast, high-rigor pipeline for producing bulletproof, receipt-heavy, authentically voiced Bluesky threads (standalone explainers, quote-post breakdowns, or direct replies) on complex political, technical, or controversial topics.

The goal is **rigor, factual precision, and authentic voice**—never a formulaic template or canned rhetorical script.

## Pipeline Overview

```
[1. Turn-1 Parallel Fetch + Cached Voice/AISIGNS Prep] ➡️ [2. Evidence Pack, Optional <1s Receipt Cards & Draft] ➡️ [3. Deterministic lint_thread.py Pass] ➡️ [4. Tiered Audit: Subagent Red-Team (Default) OR 1-Post In-Thread Fast-Path] ➡️ [5. User Approval Gate] ➡️ [6. Atomic create-thread / create-post Publish]
```

> **CRITICAL RULE — NEVER AUTO-POST WITHOUT EXPLICIT USER APPROVAL:**
> Even if the user initially says *"we should reply"* or *"let's post a thread about X,"* **NEVER** call `create-thread` or `create-post` automatically after Stage 4 (on either full red-team or fast-path). Always present the final audited draft (with exact grapheme counts, rendered card previews if any, and target `replyTo` / `quoteUri` links) and wait for explicit sign-off (e.g., *"post it"*, *"looks good, send it"*, *"ship it"*) in a subsequent turn.

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

## Stage 1: Turn-1 Parallel Context Fetch, Pronouns & Cached Prep

Save an entire round-trip by firing **primary Bluesky context + cached voice/AISIGNS prep in the same Turn-1 tool batch**:

1. **Turn-1 Parallel Tool Batch (Run Simultaneously):**
   - **Context:** Call `get-post-thread` (`detail: "compact"`, `maxRepliesPerNode: 20`) on the target URL/URI (or `public.api.bsky.app` if blocked).
   - **Pronouns & Identity:** Call `get-profile` for every known handle in the target post (checks native `Pronouns:`, `Bio:`, `Labels:`, and `Pinned Post:`).
   - **Cached Voice + Live `WP:AISIGNS` Digest (`< 0.4s` warm):** Run both cached helpers in one parallel `run_command` call right in Turn 1 (use `--mode auto` if mode isn't obvious yet):
     ```bash
     SCRATCH_DIR="<artifact_dir>/scratch" && mkdir -p "$SCRATCH_DIR" \
     && python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/sample_mike_posts.py \
       --mode <explainer|quote|reply|auto> --output "$SCRATCH_DIR/mike_voice_sample.txt" \
     && python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/fetch_aisigns_digest.py \
       --output "$SCRATCH_DIR/wp_aisigns_digest.md"
     ```
2. **Follow-Up Primary Sources & Unconfirmed Pronouns (Turn 2 Read Batch):**
   - Read `$SCRATCH_DIR/mike_voice_sample.txt`, `$SCRATCH_DIR/wp_aisigns_digest.md`, and [references/mike-voice.md](references/mike-voice.md) in a single parallel `read_file` batch alongside any follow-up lookups.
   - If a video, roll call, filing, or statute is cited, ingest the primary material (`yt-dlp` subtitles/frames, Clerk XML, FEC/Federal Register text) into `$SCRATCH_DIR`.
   - For any newly discovered person whose pronouns weren't confirmed in Turn 1, call `get-profile` / `search-posts` (`author: "<handle>"`, query: `pronouns`). If pronouns remain unconfirmed, use **name/handle** or **`"you"`** strictly—never guess.
3. **Lock In Mode, Thesis & Closing Button (Never Draft a Pure Listicle):**
   - Choose mode: `explainer` (standalone breakdown), `quote` (quote-post analysis), or `reply` (direct pushback/addition).
   - **Core Thesis:** Define the single governing argument. If multiple angles are plausible after an open-ended fact-check, clarify the angle with the user first.
   - **Closing Button:** Define where the final post lands (the real-world takeaway, clincher, or why the facts matter). Never stop dead on a stray caveat or shrug.
4. **Write `$SCRATCH_DIR/evidence_pack.md` (Required for Tier A Red-Team; Optional on Tier B 1-Post Fast-Path):**
   - Whenever Stage 4 uses the full subagent audit (see Stage 4 rules), save a concise dossier in `$SCRATCH_DIR/evidence_pack.md` (even when facts came from earlier turns in the same conversation!) listing:
     - Mode, Core Thesis, Closing Button, and target `replyTo` / `quoteUri` URLs + full OP text (including OP's immediate self-replies).
     - **Pronoun Ledger:** Every referenced person -> verified pronouns + exact source (or `unverified -> name-only`).
     - **Claim-to-Receipt Map:** Every factual claim, number, and timestamp mapped to its URL, cached file path in `$SCRATCH_DIR`, and verbatim quote **including the immediately preceding and succeeding sentences**.

---

## Stage 2: Optional `< 1s` Receipt Cards & Authentic Drafting

1. **Deterministic Receipt Cards (`render_receipt_card.py` — Never Hand-Roll HTML/Browser Scripts):**
   When visual receipts strengthen a thread (statutory/EO/filing excerpts, roll-call tallies, or archived post chains), render tightly auto-cropped `2x` Retina PNGs + accessible `imageAlts` in `< 1s` via `render_receipt_card.py`—**never probe browsers or write custom HTML/Playwright scripts**:
   - **Inline Markup (HTML-escaped safely first):** Wrap verbatim highlights in `==yellow==`, `==green:emerald==`, `==red:crimson==`, `==blue:sky==`, and bold in `**bold**`.
   - **Batch JSON Spec (`document` & `post` card types):**
     ```json
     {
       "cards": [
         {
           "type": "document",
           "output": "card1.png",
           "theme": "emerald",
           "eyebrow": "Executive Order 14141 • 90 FR 5469",
           "title": "100% New Clean Power Matching Mandate",
           "subtitle": "Hourly-Matched Generation Requirement",
           "badge": "Jan 14, 2025",
           "stats": [{ "label": "Clean Match", "value": "100%", "note": "Hourly deliverable" }],
           "boxes": [
             { "label": "Section 2(c) • Policy Mandate", "quote": "AI infrastructure ==green:must be matched with new, clean electricity generation==." }
           ],
           "footer_left": "Source: Federal Register Vol. 90, p. 5470",
           "footer_right": "Verbatim Excerpt (1 of 2)"
         },
         {
           "type": "post",
           "output": "card2.png",
           "theme": "blue",
           "surface": "light",
           "eyebrow": "In-Thread Walkback Receipt",
           "title": "Author's Immediate Follow-Up",
           "badge": "Bluesky",
           "posts": [
             { "name": "Jane Doe", "handle": "@janedoe.bsky.social", "date": "Nov 10, 2026 • 2:14 PM", "text": "Verbatim ==highlighted post== text.", "note": "Optional context note" }
           ],
           "footer_left": "Archived Nov 10, 2026"
         }
       ]
     }
     ```
     Run once and inspect every output PNG visually via `read_file`:
     ```bash
     python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/render_receipt_card.py \
       "$SCRATCH_DIR/cards_spec.json" --out-dir "$SCRATCH_DIR" --manifest "$SCRATCH_DIR/cards_manifest.json"
     ```
     *(For a quick 1-card excerpt, pass flags directly: `--type document --theme crimson --eyebrow "..." --title "..." --badge "..." --section "..." --quote "..." --footer-left "..." -o "$SCRATCH_DIR/card1.png"`.)*

2. **Drafting Rules (`Hook ➡️ Receipts ➡️ Button`):**
   - **Match Mode to Context:** Open naturally for an `explainer`, `quote`, or `reply`. Never copy one-off openers (like `"TBF,"`) from a single sampled post or force a canned `"concession -> trapdoor"` formula.
   - **Post 1 (Hook & Thesis):** Anyone seeing only Post 1 in their feed should immediately grasp the point.
   - **Middle Posts (Receipts):** Advance the thesis with concrete specifics; avoid disconnected listicle bullets.
   - **Final Post (Button):** Land the plane cleanly on the core takeaway.
   - **Hard Mechanical Constraints:**
     - **Zero Em Dashes (`—` or `--`):** Use commas, colons, parentheses, or periods.
     - **Zero Emojis (including `🧵`):** Never include unless explicitly requested.
     - **Strict Limit:** Every post MUST be **`<= 300` graphemes** (and `<= 3000` UTF-8 bytes), with descriptive `imageAlts` for every attached image (use the manifest's `imagePaths` + `imageAlts`).

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

## Stage 4: Tiered Red-Team Audit Gate

Choose the tier strictly by structural risk—**when in doubt, always run Tier A**:

### Tier A — Full Subagent Red-Team (`TypeName: "self"`, Mandatory Default)
**Required whenever ANY of these hold:**
- Multi-post thread (`2+` posts), standalone `explainer`, or `quote` breakdown
- Any attached image or receipt card (`imagePaths` non-empty)
- Any external factual claim, roll-call tally, statute/EO/FEC filing, dollar/percentage math, or transcript/video timestamp

Invoke `invoke_subagent` with **`TypeName: "self"`** and **`Model: "inherit"`** (never `research`, which lacks network/MCP access, and never downgrade model quality) and `Role: "Red Team Critic & Voice Auditor"`, passing `$SCRATCH_DIR/draft.json`, `$SCRATCH_DIR/evidence_pack.md`, `$SCRATCH_DIR/mike_voice_sample.txt`, `$SCRATCH_DIR/wp_aisigns_digest.md`, and [references/red-team-rubric.md](references/red-team-rubric.md):
- **Strict Read-Only External Boundary:** The subagent MUST **never** call `create-post`, `create-thread`, `delete-post`, or edit repository files—only read sources, run targeted verification queries, and write `$SCRATCH_DIR/draft_redteamed.json`.
- **Zero Cold-Start Re-Googling:** Start from `$SCRATCH_DIR/evidence_pack.md` and cached `$SCRATCH_DIR` files; spend 100% of external queries trying to **break** the draft (adjacent roll calls, footnotes, OP follow-ups, rival definitions, visual card accuracy, pedant escape hatches).
- **Single-Owner Structural Rewrite & Lint:** If the audit uncovers factual traps, an unbuttoned ending, or a stronger narrative arc, **rewrite from scratch** rather than patching clunky edits into old post splits, save `$SCRATCH_DIR/draft_redteamed.json`, and run `lint_thread.py` once to confirm `0` hard errors before returning.

### Tier B — 1-Post In-Thread Reply Fast-Path (Inline Rubric + `lint_thread.py`)
**Permitted ONLY when ALL 4 conditions hold:**
1. Single-post (`1`-post) direct reply (`mode == "reply"`)
2. Zero attached images/cards (`imagePaths` empty)
3. References **only** already-fetched in-thread context (`get-post-thread` + verified `get-profile` pronouns) with **zero** new external stats, filings, roll calls, timestamps, or math
4. You walk through all 4 Audit Areas in [references/red-team-rubric.md](references/red-team-rubric.md) inline (OP follow-up/walkback check, pronoun check, pedant dunk simulation, voice + `WP:AISIGNS` check) and confirm `lint_thread.py --mode reply "$SCRATCH_DIR/draft.json"` passes with `0` hard errors.

---

## Stage 5: Mandatory User Approval Gate

1. **STOP** immediately after Stage 4 completes (both Tier A and Tier B).
2. Present the final hardened copy, exact grapheme counts (`N/300`), attached receipt cards/alts (if any), and target `replyTo` / `quoteUri` links.
3. **Wait for explicit user sign-off** before publishing anything.

---

## Stage 6: One-Call Verified Publishing (Only After Approval)

Once the user approves:
- **Multi-post thread:** Publish in **one single tool call** via `create-thread` (`ServerName: "bluesky"`, `ToolName: "create-thread"`), passing `posts` and optional `replyTo` directly from the approved JSON.
- **Single post:** Publish via `create-post` (`ServerName: "bluesky"`, `ToolName: "create-post"`).
- **Confirm Post-Flight Status:** `create-thread` and `create-post` automatically validate all posts pre-flight, verify every committed PDS record (`reply.parent`, `reply.root`, and `embed` type/quote/images) post-flight, and auto-rollback on mismatch. Confirm the response reports `Post-Flight: PASS`!
  - *Fallback for stale MCP sessions:* If the running `bluesky` MCP server predates `create-thread` (or reports `Post-Flight: skipped`), publish sequentially via `create-post` and batch-verify all returned URIs in one `get-posts` call (`detail: "full"`), deleting (`delete-post`) and re-posting immediately if any `reply` or `embed` mismatched.
