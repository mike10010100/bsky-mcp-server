---
name: bsky-troll-handler
description: Monitor Bluesky notifications, draft firm counter-arguments against trolls/bad-faith actors, and manually submit them via Chrome DevTools with verification. Use when a user needs to respond to persistent antisocial behavior on Bluesky while maintaining a documentation-focused persona.
---

# Bluesky Troll Handler

This skill formalizes the process of identifying, countering, and documenting bad-faith actors on Bluesky with minimal engagement overhead.

## Workflow

### 1. Identify Target Replies
- Call `mcp_bluesky_get-notifications` with `reasons: ["reply"]`.
- Identify unread replies from specific actors.
- **SERIAL VERIFICATION:** Use `mcp_bluesky_get-post-thread` to fetch the full context and history for each identified URI. You MUST verify each post **individually and serially** to ensure the authenticated user's DID/handle is not already present in the replies. Do NOT rely on batch processing or cached results for this step.
- **DIRECT REPLY VERIFICATION:** For every target post, you MUST verify that it is a **direct response** to the authenticated user.
  - Inspect the `reply_to` field in the post record.
  - Confirm the target DID matches Mike's DID (`did:plc:mmtjkssv6jeneahkgfdxuy7p`).
  - If the post is a reply to a third party or a self-reply from the troll, it MUST be ignored.
- **Thread Relevance:** Ensure the reply is part of a thread you are already documenting or a direct follow-up to your previous counter-arguments. Ignore "side-quests" or unrelated threads the troll may be engaging in.
- Use `mcp_bluesky_get-post-thread` to verify the `reply_to` relationship and context.

### 2. Draft Counter-Arguments
- Adopt the **Counter-Argument Persona** (see [persona.md](references/persona.md)).
- **UNIQUE RESPONSES:** Every response MUST be original. Do not repeat the same counter-argument across different threads, even if the troll is using repetitive tactics.
- **CONTEXTUAL RELEVANCE:** Every reply MUST be strictly on-topic and relevant to the specific thread and target post content. Do not provide generic dismissals; tailor the observation to the current bad-faith pivot.
- **Keep it Pithy:** Responses must be short, direct, and to the point (ideally 1-2 sentences).
- Focus on calling out tactics: goalpost shifting, concern trolling, meta-trolling, and antisocial persistence.
- Frame all responses as documentation for the public record.
- **Approval Format:** Present drafts to the user in a Markdown table with the following columns:
  - **Target Post Content:** A brief snippet or summary of the troll's reply.
  - **Target Post URL:** A direct link to the post.
  - **Drafted Counter-Argument:** The proposed response in persona.

### 3. Verified Manual Submission
For each approved reply, follow the **Verified Manual Submission Workflow** (see [workflow.md](references/workflow.md)):
1.  **Navigate** to the post using Chrome DevTools.
2.  **Verify Load** by waiting for specific post text.
3.  **Initiate Reply** and wait for the "Write your reply" editor state.
4.  **Type & Verify** text entry via snapshot.
5.  **Publish & Verify visibility** via final snapshot after a short delay.

## Core Rules
- **Short & Sharp:** Never use five words when two will do.
- **Direct Hits Only:** Only respond to replies addressed to you.
- **One at a time:** Process threads sequentially to avoid confusion and rate-limiting.
- **Verification is Mandatory:** Never assume a post was submitted without seeing it in a snapshot.
- **Stay in Persona:** Maintain the firm, documentation-focused tone established in the persona reference.
