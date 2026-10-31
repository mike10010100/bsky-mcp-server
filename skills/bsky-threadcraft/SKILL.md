---
name: bsky-threadcraft
description: Researches, drafts, de-AI-ifies, and red-teams bulletproof Bluesky reply threads matching Mike Paulauski's authentic voice (@mike10010100.com). Enforces strict <= 300 character limits, dynamic Wikipedia AI-ism checks (WP:AISIGNS), and automated subagent adversarial auditing.
---

# Bluesky Threadcraft

This skill formalizes the 4-stage pipeline for producing bulletproof, receipt-heavy, and authentically voiced Bluesky reply threads on complex political, technical, or controversial topics.

## Pipeline Overview

```
[1. Primary Source Ingestion] ➡️ [2. Mike Voice Drafting] ➡️ [3. Wikipedia AI-ism Strip] ➡️ [4. Red-Team Subagent Audit] ➡️ [5. Verified Posting]
```

---

## Stage 1: Primary Source Ingestion & Fact Grounding

Before writing a single word:
1. **Fetch Context via MCP / Tools:**
   - Fetch the root post, parent post, and immediate thread context using `mcp_bluesky_get-post-thread`.
   - If a video or link is cited, use `yt-dlp` (subtitles/info JSON) or search tools to ingest the actual primary material.
2. **Catalog Receipts:**
   - Extract exact timestamps, verbatim quotes, and surrounding context.
   - Note the physical setting, attire, and demeanor if a video is involved (download thumbnail or frames if needed).
   - Identify the core contradiction: *Where does the subject's claim clash with verifiable reality or their own previous statements?*

---

## Stage 2: Drafting in Mike's Authentic Voice

Draft a thread (usually 2–6 posts) tailored strictly to Mike Paulauski's persona (see [references/mike-voice.md](references/mike-voice.md)):
- **Steelman First (The Good Faith Hook):** If the counterparty made a valid point or if their source has genuine merits, acknowledge it cleanly in Post 1 (*"TBF, you're right that..."*). This instantly disarms accusations of bad-faith trolling.
- **Turn the Trapdoor:** Use the concession to pivot to the exact contradiction where the defense breaks down (*"Except... there were no trolls in the studio when he..."*).
- **Style Constraints:**
  - **Zero Em Dashes (`—`):** Never use them. Use commas, colons, parentheses, or ellipses.
  - **Vocal Stress:** Use `*asterisks*` around key words for emphasis.
  - **Diction:** Natural colloquialisms (*"TBF"*, *"cuz"*, *"gonna"*, *"wild"*, *"folks"*, *"ratfuck"*).
  - **Length:** **Every single post MUST be strictly <= 300 characters.**

---

## Stage 3: The Wikipedia AI-ism Strip (`WP:AISIGNS`)

Audit the draft against `Wikipedia:Signs of AI writing` (see [references/wikipedia-ai-isms.md](references/wikipedia-ai-isms.md)):
- **Purge Triads ("Rule of Three"):** Check every list. LLMs obsessively group items in threes (*"housing, healthcare, and labor"* -> cut to two or one).
- **Purge Negative Parallelisms:** Search for *"not X, but Y"* or *"not just X, it's Y"*. Rewrite as direct positive statements.
- **Purge AI Filler Vocabulary:** Ensure no *delve, underscore, showcase, pivotal, tapestry, landscape, testament, crucial, multifaceted*.
- **Purge Essay Signposting:** Remove mechanical markers like *"First... Second... Third..."* or *"Furthermore... In conclusion..."*.

Run a Python verification snippet to confirm:
```python
assert all(len(p) <= 300 for p in posts)
assert all("—" not in p for p in posts)
```

---

## Stage 4: Subagent Red-Team Audit

Dispatch an adversarial subagent using `invoke_subagent` with the role `Red Team Critic & Voice Auditor` following [references/red-team-rubric.md](references/red-team-rubric.md):
- **Quote & Context Integrity:** Verify the "next sentence" rule. Did the quoted speaker qualify their statement right after the cited timestamp?
- **Counterparty Simulation:** Roleplay how defenders will counter-attack. Identify semantic escape hatches (e.g. terminology hair-splitting) and pre-empt them.
- **Visual Check:** Confirm visual claims match disk evidence.
- **Final Polish:** Return hardened copy with confirmed character counts.

---

## Stage 5: Verified Thread Posting

Post the thread sequentially using `mcp_bluesky_create-post`:
1. Post 1 replies to the target post URL or URI.
2. Post 2 replies to Post 1's returned URI.
3. Post 3 replies to Post 2's returned URI, and so on.
4. Report the live thread URLs to the user upon completion.
