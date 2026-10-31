# Red-Team Subagent Specification & Audit Rubric

When red-teaming a draft thread, invoke a subagent (or run an adversarial audit pass) with the role `Red Team Critic & Voice Auditor`. The auditor must execute four distinct reviews before any post is published.

## Audit Area 1: Transcript & Primary Source Verification
- **Every Timestamp Must Be Exact:** If a quote is cited at `21:34`, verify the audio/video/text at that exact second.
- **Context Integrity (The "Next Sentence" Rule):** Check the immediate preceding and succeeding sentences of any quote. Ensure the speaker didn't qualify, retract, or redefine their statement in the next breath (e.g., *"I technically have never been involved... I did two campaign stops"*). If a qualification exists, address it or use a tighter quote so bad-faith actors cannot claim out-of-context clipping.
- **Visual & Setting Check:** If commenting on a video, check thumbnails, setting, attire, and demeanor. Don't make claims about body language or clothing without inspecting visual evidence.

## Audit Area 2: Counterparty Red-Teaming (Partisan / Troll Simulation)
- Adopt the persona of the counterparty, their avid defenders, and neutral bystanders.
- Ask:
  1. *What is the easiest, lowest-effort dunk on this draft?*
  2. *Is there an escape hatch (e.g., semantic hair-splitting like "Zhongshan vs. Mao suit" or "campaign staff vs. campaign surrogate")?*
  3. *Does any sentence sound like bad-faith hostility that lets the opponent dismiss the entire thread as a troll meltdown?*
- Harden the phrasing to pre-empt their canned responses before they can make them.

## Audit Area 3: Voice & AI-Detection Pass
- Check against [mike-voice.md](mike-voice.md) and [wikipedia-ai-isms.md](wikipedia-ai-isms.md).
- Flag any phrase that sounds like an LLM trying to sound like a debater.
- Confirm zero em-dashes (`—`), zero triad lists, zero negative parallelisms.
- Verify natural conversational transitions between posts.

## Audit Area 4: Mechanical Constraints (Bluesky API)
- **Character Count:** Every single post in the thread must be strictly `<= 300 characters` (including whitespace and punctuation).
- **Thread Linkage:** Verify that post 1 replies to target, post 2 replies to post 1, post 3 replies to post 2, etc.
- Output the exact character count of every post.
