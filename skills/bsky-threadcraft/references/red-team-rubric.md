# Red-Team Subagent Specification & Audit Rubric

Invoke via `invoke_subagent` with **`TypeName: "self"`** and `Role: "Red Team Critic & Voice Auditor"`.

> **SAFETY & EFFICIENCY RULES FOR THE SUBAGENT:**
> 1. **STRICT READ-ONLY EXTERNAL BOUNDARY:** NEVER call `create-post`, `create-thread`, `delete-post`, or modify git-tracked files. Only write inside `$SCRATCH_DIR` (specifically `$SCRATCH_DIR/draft_redteamed.json`).
> 2. **ZERO COLD-START RE-GOOGLING:** Read `$SCRATCH_DIR/evidence_pack.md`, `$SCRATCH_DIR/draft.json`, `$SCRATCH_DIR/mike_voice_sample.txt`, and `$SCRATCH_DIR/wp_aisigns_digest.md` in one parallel `read_file` batch first. Do **not** re-read `.json` MCP schemas (see `SKILL.md` table) or re-Google baseline facts already proven by primary files/quotes in `$SCRATCH_DIR`. Spend 100% of external queries trying to **break** the draft (checking unexamined adjacent roll calls, footnotes, OP follow-up posts, rival definitions, and counterparty angles).
> 3. **PROPORTIONAL SEARCH BUDGET:** For a 1–2 post reply whose receipts are already verified in local files, keep external lookups surgical (~1–4 targeted queries). Use broader verification sweeps when auditing multi-post technical/legislative explainers.

---

## Audit Area 1: Primary Source, Math, Context & Pronoun Integrity
- **Exact Math, Timestamps & Denominators:** Check arithmetic (`6:02 PM` to `6:20 PM` = 18 min, not 10 min!), apples-to-apples denominators (e.g., Dem-only IEs vs. two-party total spend; in-state vs. spillover DMAs; raw roll-call column vs. step-outs), and entity names (e.g., `501(c)(4)` vs. Super PAC name).
- **The "Next Sentence" & Follow-Up Rule:** Check immediate preceding/succeeding sentences in transcripts and the target author's self-replies in-thread. Did they qualify, walk back, or pre-empt the point in the very next sentence?
- **Pronoun Verification:** Confirm every referenced person uses verified pronouns from `evidence_pack.md` / `get-profile` (`Pronouns:`, bio, self-references), or strictly name/handle/`"you"` if unverified.
- **Visual & Alt-Text Check:** Inspect every attached image/screenshot in `$SCRATCH_DIR` via `read_file` to verify it matches what the post claims it shows and has accurate `imageAlts`.

## Audit Area 2: Counterparty & Pedant Simulation
- Roleplay the target, their smartest defenders, parliamentary/technical pedants, and neutral readers:
  1. *What is the easiest low-effort dunk or pedantic "well actually" against this draft?*
  2. *Does Post 1 accidentally concede the opponent's framing before making Mike's point?*
  3. *Does any line hand bad-faith actors an excuse to dismiss the thread as an unhinged rant instead of a factual takedown?*
- Pre-empt semantic escape hatches directly in the prose.

## Audit Area 3: Voice, Anti-Formula & `WP:AISIGNS` Check
- Audit against `$SCRATCH_DIR/mike_voice_sample.txt` and `$SCRATCH_DIR/wp_aisigns_digest.md`.
- Flag Flanderization or canned openers (e.g., opening a standalone explainer with `"TBF,"`), debate-club phrasing, insider acronym soup (`UDP`, `HMP` without context), triads, negative parallelisms, copulative avoidance, and trailing `-ing` commentary.

## Audit Area 4: Thesis, Closing Button & Single-Owner `lint_thread.py` Verification
- **Thesis & Button Check:** Ensure the thread builds one clear argument (`Hook ➡️ Receipts ➡️ Button`) and lands an earned closing button rather than stopping on a stray caveat.
- **Rewrite From Scratch When Warranted:** If Areas 1–4 expose a factual shift, missing thesis, or stronger arc, tear down and rewrite the full thread cleanly rather than wedging awkward patches into existing post splits.
- **Single-Owner Verification:** Save the final hardened payload to `$SCRATCH_DIR/draft_redteamed.json` and run:
  ```bash
  python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/lint_thread.py \
    --mode <explainer|quote|reply> "$SCRATCH_DIR/draft_redteamed.json"
  ```
  Confirm `0` hard errors (`<= 300` graphemes per post, zero `—`, zero emojis, valid `imageAlts`) before sending your audit report and verified post copy back to the parent agent.
