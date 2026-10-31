# Wikipedia AI-isms & LLM Tells Audit (`WP:AISIGNS`)

Based on the community-maintained English Wikipedia guide `Wikipedia:Signs of AI writing` (`WP:AISIGNS`) and automated cleanup heuristics. Every draft post must be audited against these categories before submission.

## 1. Punctuation & Typography
- **The Em Dash (`—`):** Historically the single biggest tell of LLM generation. Models use em dashes compulsively to create dramatic pauses or punchy asides where humans use commas, parentheses, colons, or periods. **Strict rule: Zero em dashes.**
- **Curled Smart Quotes or Stray Markdown Glitches:** Ensure clean standard quotes and backticks.

## 2. Structural & Rhetorical Tells
- **The Rule of Three (Compulsive Triads):** LLMs love grouping items, benefits, or adjectives into triads (*"innovative, transformative, and groundbreaking"*, *"housing, healthcare, and labor dignity"*). Break them up into pairs or singular direct points.
- **Negative Parallelisms:** Contrast formulas like:
  - *"It's not just X, it's Y"*
  - *"Not X, but rather Y"*
  - *"That's not about X; it's about Y"*
  Models rely on this heavily for synthetic gravitas. State the point directly instead of using the negation setup.
- **Formulaic Concession-Then-Pivot Transitions:**
  - AI essay pattern: *"While X is certainly true... nevertheless, Y remains crucial."*
  - Avoid chaining textbook transition markers across consecutive posts: *"First... Second... Third..."* or *"Meanwhile... Furthermore... Consequently..."*.
- **Superficial "-ing" Analytical Clauses:**
  Tacking participial phrases onto the end of sentences (*"...highlighting the importance of..."*, *"...underscoring the divide..."*, *"...fostering a sense of community..."*). Cut the tail; end on the factual assertion.

## 3. High-Frequency AI Vocabulary (Purge on Sight)
Do not use these words or their variations:
- **Verbs:** *delve, underscore, showcase, highlight, bolster, foster, garner, exemplify, align with, intertwine*
- **Adjectives & Adverbs:** *pivotal, crucial, vital, paramount, fundamental, meticulous, multifaceted, vibrant, nuanced, enduring, stark*
- **Nouns:** *tapestry, landscape, interplay, testament, beacon, crux, plethora*
- **Formulas:** *"stands as a testament"*, *"serves as a reminder"*, *"in today's fast-paced world"*, *"plays a key role"*

## 4. Live Verification Command
When auditing, the agent can run a quick search or Python regex check to verify zero occurrences of em dashes, negative parallelisms, or banned stems.
