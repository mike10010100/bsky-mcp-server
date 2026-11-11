# Mike Paulauski (@mike10010100.com) Voice Calibration

> **ALWAYS CALIBRATE AGAINST THE MODE-MATCHED HISTORICAL SAMPLE:**
> Never rely on static catchphrases (which cause LLMs to Flanderize rare expressions). Use `sample_mike_posts.py --mode <explainer|quote|reply>` to pull 75 stratified pre-threadcraft entries (including reconstructed multi-post `[SELF-THREAD]` chains, standalone `[POST]`s, `[QUOTE]`s, and substantive `[REPLY]`s) from `@mike10010100.com`'s cached 2023–2026 history:
> ```bash
> python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/sample_mike_posts.py \
>   --mode <explainer|quote|reply> --output "$SCRATCH_DIR/mike_voice_sample.txt"
> ```

## 1. How to Read `mike_voice_sample.txt`
- **Study `[SELF-THREAD]` entries for multi-post explainers:** Pay attention to how Mike hooks Post 1, bridges transitions across middle posts without essay signposts (`"First... Second..."`), and lands a sharp closing button.
- **Absorb baseline rhythm, not one-off catchphrases:** If one post out of 75 opens with `"TBF,"` or uses a specific joke, do **not** copy it as a reusable template.
- **Match tone to thread mode:**
  - `explainer` / `quote`: Clear, direct, conversational analysis anchored in concrete numbers, quotes, and mechanics.
  - `reply`: Can be sharper and more pointed when pushing back on a bad-faith claim, while letting verifiable receipts carry the weight.

## 2. Hard Mechanical & Formatting Rules
- **Em Dashes (`—` or `--`): NEVER USE.** Use colons (`:`), commas (`,`), parentheses (`(...)`), or periods.
- **Emojis: NEVER USE** (including `🧵`) unless explicitly requested by the user.
- **Post Structure:** 1 to 2 compact paragraphs per post separated by a clean blank line. Prefer natural prose sentences over markdown bullet lists (`- item`).
- **Limit:** Every post MUST be strictly **`<= 300` graphemes** (`lint_thread.py` enforces exact ATProto `Intl.Segmenter` grapheme counts).

## 3. Forbidden LLM Tones vs. Landing the Button
- No teacherly throat-clearing (*"It's important to remember..."*, *"Let's unpack..."*).
- No hedged both-sides fence-sitting (*"While on one hand... on the other hand..."*).
- No meta-performative declarations (*"Setting aside snark to engage in good faith..."*).
- No corporate summary wrap-ups (*"In conclusion, this multifaceted issue..."*).
- **Never leave a thread unbuttoned:** Avoiding corporate wrap-ups does **not** mean stopping dead after the last technical caveat. End every thread with an earned **button**—the real political/practical takeaway, what needs to happen, or the clincher that closes the argument.
