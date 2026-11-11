# Wikipedia AI-isms & LLM Tells Audit (`WP:AISIGNS`)

> **LIVE REVISION-CACHED DIGEST (`fetch_aisigns_digest.py`):**
> Do **not** dump the raw 180 KB MediaWiki wikitext (which triggers multi-turn byte truncations and fills context with `<ref>` and AfC noise). Always run `fetch_aisigns_digest.py`, which verifies Wikipedia's live `revid` for `Wikipedia:Signs_of_AI_writing`, updates `~/.cache/bsky-threadcraft/wp_aisigns_cache.json` whenever the page changes, and writes a clean `< 18 KB` prose digest (`wp_aisigns_digest.md`) plus machine-readable rules (`wp_aisigns_rules.json`) consumed automatically by `lint_thread.py`:
> ```bash
> python3 /home/mike10010100/.gemini/config/skills/bsky-threadcraft/scripts/fetch_aisigns_digest.py \
>   --output "$SCRATCH_DIR/wp_aisigns_digest.md"
> ```

Read `$SCRATCH_DIR/wp_aisigns_digest.md` alongside these core categories and run `lint_thread.py` on `$SCRATCH_DIR/draft.json`:

## 1. Punctuation & Typography
- **Zero Em Dashes (`—` or `--`):** LLMs use em dashes compulsively for dramatic pivots. Use commas, parentheses, colons, or periods.
- **Clean Typography:** Zero emojis unless requested; keep quotes and punctuation clean.

## 2. Structural & Rhetorical Tells
- **Compulsive Triads ("Rule of Three"):** Break automatic 3-item rhetorical groupings (*"speed, scale, and efficiency"*, *"housing, healthcare, and labor"*) into direct singular points or pairs (purely factual enumerations of 3 named bills/votes are fine when warranted).
- **Negative Parallelisms:** Purge contrast formulas used for synthetic gravitas:
  - *"It's not just X, it's Y"* / *"Not only X, but also Y"*
  - *"Not X, but rather Y"* / *"That's not about X; it's about Y"*
  - *"No X, no Y, just Z"*
  State what the thing actually is directly.
- **Copulative Avoidance:** Don't replace simple *"is" / "are" / "has"* with inflated verbs (*"serves as"*, *"stands as"*, *"functions as"*, *"boasts"*, *"holds the distinction of"*).
- **Superficial `-ing` Analytical Tails:** Cut trailing participial commentary (*"...highlighting the divide"*, *"...underscoring the stakes"*, *"...fostering accountability"*). End on the concrete fact.
- **Mechanical Essay Signposting:** Avoid *"First... Second... Third..."*, *"Furthermore,"*, *"Moreover,"*, or *"Ultimately,"*.

## 3. High-Frequency AI Vocabulary (Auto-Checked via `wp_aisigns_rules.json`)
Purge unless inside a verbatim quote:
- **Verbs:** *delve, underscore, showcase, highlight, bolster, foster, garner, exemplify, align with, intertwine*
- **Adjectives/Adverbs:** *pivotal, crucial, paramount, multifaceted, meticulous, vibrant, nuanced, enduring, stark, Additionally (sentence-initial)*
- **Nouns/Formulas:** *tapestry, landscape (figurative), interplay, testament, beacon, crux, plethora, "stands as a testament", "serves as a reminder"*
