import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Agent, AtpAgent, RichText } from "@atproto/api";
import fs from 'fs';
import path from 'path';
import {
  cleanHandle,
  facetsToMarkdown,
  formatIsoTimestamp,
  formatSummaryText,
  getFeedNameFromId,
  validateUri,
  convertBskyUrlToAtUri,
  isValidPostAtUri,
  normalizePostUri,
  resolvePdsEndpoint,
  extractFirstUrl,
  mcpErrorResponse,
  mcpSuccessResponse,
} from './utils.js';
import { preprocessPosts, formatPostThread } from "./llm-preprocessor.js";
import { resourcesList } from './resources.js';
import { fetchLinkMetadata, uploadThumbnail } from './link-preview.js';

/**
 * Return the effective feed timestamp of an item (repost time for reposts, otherwise post createdAt/indexedAt).
 */
function getFeedItemTimestamp(item: any): Date | null {
  const raw =
    (item?.reason?.$type === 'app.bsky.feed.defs#reasonRepost' ? item.reason.indexedAt : undefined) ||
    item?.post?.record?.createdAt ||
    item?.post?.indexedAt;
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a post URI/URL to its canonical AT URI, CID, and PostView using lightweight getPosts
 * (falling back to getPostThread when getPosts is not stubbed in unit tests).
 */
async function resolvePostTarget(
  agent: Agent,
  uriOrUrl: string,
  handleCache?: Map<string, string>
): Promise<{ uri: string; cid: string; post: any } | { error: string }> {
  const normalized = await normalizePostUri(uriOrUrl, agent, handleCache);
  if (!normalized) {
    return {
      error: `Invalid Bluesky post URI or URL: "${uriOrUrl}". Expected at://did:.../app.bsky.feed.post/... or https://bsky.app/profile/.../post/...`,
    };
  }

  if (typeof agent.app?.bsky?.feed?.getPosts === 'function') {
    const res = await agent.app.bsky.feed.getPosts({ uris: [normalized] });
    if (res?.success && Array.isArray(res.data?.posts) && res.data.posts.length > 0) {
      const p = res.data.posts[0];
      if (p?.cid) {
        return { uri: p.uri || normalized, cid: p.cid, post: p };
      }
    }
    return { error: `Post not found (it may have been deleted): ${normalized}` };
  }

  if (typeof agent.app?.bsky?.feed?.getPostThread === 'function') {
    const res = await agent.app.bsky.feed.getPostThread({ uri: normalized, depth: 0, parentHeight: 0 });
    const post = (res?.data?.thread as any)?.post;
    if (res?.success && post?.cid) {
      return { uri: post.uri || normalized, cid: post.cid, post };
    }
  }

  return { error: `Could not resolve post information for: ${normalized}` };
}

interface PostDraftInput {
  text: string;
  quoteUri?: string;
  imagePaths?: string[];
  imageAlts?: string[];
  previewUrl?: string;
  embedPreview?: boolean;
}

interface PreparedPostDraft {
  text: string;
  facets?: any[];
  graphemeLength: number;
  resolvedQuoteUri: string | null;
  resolvedQuoteCid: string | null;
  imagePaths: string[];
  imageAlts: string[];
  previewUrl?: string;
  embedPreview: boolean;
}

/**
 * Validate a single post's text (300 graphemes / 3000 UTF-8 bytes), image paths (<= 4 and exist on disk),
 * and quote target (fail-closed if quoteUri is provided) BEFORE uploading blobs or publishing records.
 */
async function validateAndPreparePostDraft(
  agent: Agent,
  input: PostDraftInput,
  handleCache?: Map<string, string>,
  labelPrefix: string = 'Post'
): Promise<{ draft: PreparedPostDraft } | { error: string }> {
  const rt = new RichText({ text: input.text });
  await rt.detectFacets(agent);

  if (rt.graphemeLength > 300) {
    return {
      error: `${labelPrefix} exceeds Bluesky's 300-grapheme limit (${rt.graphemeLength} graphemes).`,
    };
  }
  const byteLength = Buffer.byteLength(rt.text, 'utf8');
  if (byteLength > 3000) {
    return {
      error: `${labelPrefix} exceeds Bluesky's 3000-byte UTF-8 limit (${byteLength} bytes).`,
    };
  }

  const imagePaths = input.imagePaths ?? [];
  if (imagePaths.length > 4) {
    return {
      error: `${labelPrefix} specifies ${imagePaths.length} images; Bluesky allows at most 4 images per post.`,
    };
  }
  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) {
      return { error: `${labelPrefix} image file not found: ${imgPath}` };
    }
  }

  let resolvedQuoteUri: string | null = null;
  let resolvedQuoteCid: string | null = null;

  if (input.quoteUri && input.quoteUri.trim()) {
    const quoteTarget = await resolvePostTarget(agent, input.quoteUri, handleCache);
    if ('error' in quoteTarget) {
      return { error: `${labelPrefix} quoteUri failed: ${quoteTarget.error}` };
    }
    resolvedQuoteUri = quoteTarget.uri;
    resolvedQuoteCid = quoteTarget.cid;
  } else if (
    input.previewUrl &&
    input.previewUrl.includes('bsky.app/profile/') &&
    input.previewUrl.includes('/post/')
  ) {
    const quoteTarget = await resolvePostTarget(agent, input.previewUrl, handleCache);
    if ('error' in quoteTarget) {
      return { error: `${labelPrefix} previewUrl Bluesky post lookup failed: ${quoteTarget.error}` };
    }
    resolvedQuoteUri = quoteTarget.uri;
    resolvedQuoteCid = quoteTarget.cid;
  }

  return {
    draft: {
      text: rt.text,
      facets: rt.facets && rt.facets.length > 0 ? rt.facets : undefined,
      graphemeLength: rt.graphemeLength,
      resolvedQuoteUri,
      resolvedQuoteCid,
      imagePaths,
      imageAlts: input.imageAlts ?? [],
      previewUrl: input.previewUrl,
      embedPreview: input.embedPreview ?? true,
    },
  };
}

/**
 * Materialize blobs/link cards and publish a validated post draft.
 */
async function publishPreparedPostDraft(
  agent: Agent,
  draft: PreparedPostDraft,
  replyRefs?: { parent: { uri: string; cid: string }; root: { uri: string; cid: string } }
): Promise<{
  uri: string;
  cid: string;
  embedSummary: string;
}> {
  const record: any = {
    text: draft.text,
    createdAt: new Date().toISOString(),
  };

  if (draft.facets) {
    record.facets = draft.facets;
  }
  if (replyRefs) {
    record.reply = replyRefs;
  }

  let imagesEmbed: any = null;
  if (draft.imagePaths.length > 0) {
    const uploadedImages = [];
    for (let i = 0; i < draft.imagePaths.length; i++) {
      const imgPath = draft.imagePaths[i];
      const mimeType = getMimeType(imgPath);
      const imageBytes = await fs.promises.readFile(imgPath);
      const uploadRes = await agent.uploadBlob(imageBytes, { encoding: mimeType });
      if (!uploadRes.success) {
        throw new Error(`Failed to upload image blob: ${imgPath}`);
      }
      uploadedImages.push({
        image: uploadRes.data.blob,
        alt: draft.imageAlts[i] || '',
      });
    }
    imagesEmbed = {
      $type: 'app.bsky.embed.images',
      images: uploadedImages,
    };
  }

  let embedSummary = 'none';
  if (draft.resolvedQuoteUri && draft.resolvedQuoteCid && imagesEmbed) {
    record.embed = {
      $type: 'app.bsky.embed.recordWithMedia',
      record: {
        $type: 'app.bsky.embed.record',
        record: {
          uri: draft.resolvedQuoteUri,
          cid: draft.resolvedQuoteCid,
        },
      },
      media: imagesEmbed,
    };
    embedSummary = `recordWithMedia (quote ${draft.resolvedQuoteUri} + ${draft.imagePaths.length} image(s))`;
  } else if (draft.resolvedQuoteUri && draft.resolvedQuoteCid) {
    record.embed = {
      $type: 'app.bsky.embed.record',
      record: {
        uri: draft.resolvedQuoteUri,
        cid: draft.resolvedQuoteCid,
      },
    };
    embedSummary = `record (quote ${draft.resolvedQuoteUri})`;
  } else if (imagesEmbed) {
    record.embed = imagesEmbed;
    embedSummary = `images (${draft.imagePaths.length})`;
  } else if (draft.embedPreview) {
    const urlToPreview = draft.previewUrl || extractFirstUrl(draft.text);
    if (urlToPreview) {
      const metadata = await fetchLinkMetadata(urlToPreview);
      if (metadata) {
        const externalEmbed: any = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: metadata.url,
            title: metadata.title,
            description: metadata.description,
          },
        };
        if (metadata.imageUrl) {
          const thumbBlob = await uploadThumbnail(agent, metadata.imageUrl);
          if (thumbBlob) {
            externalEmbed.external.thumb = thumbBlob;
          }
        }
        record.embed = externalEmbed;
        embedSummary = `external (${metadata.url})`;
      }
    }
  }

  const response = await agent.post(record);
  return {
    uri: response.uri,
    cid: response.cid,
    embedSummary,
  };
}

/**
 * Post-flight verification of a newly published post record directly against the author's PDS
 * (`com.atproto.repo.getRecord`) to ensure reply linkage and quote/media embeds match expectations.
 * Gracefully skips if `com.atproto.repo.getRecord` is not available (e.g. lightweight unit test stubs).
 */
async function verifyPublishedPostRecord(
  agent: Agent,
  uri: string,
  draft: PreparedPostDraft,
  replyRefs?: { parent: { uri: string; cid: string }; root: { uri: string; cid: string } }
): Promise<{ verified: boolean; detail: string }> {
  const getRecordFn = (agent as any)?.com?.atproto?.repo?.getRecord;
  if (typeof getRecordFn !== 'function') {
    return { verified: false, detail: 'skipped (getRecord unavailable)' };
  }

  const parts = uri.replace(/^at:\/\//, '').split('/');
  const [repo, collection, rkey] = parts;
  if (!repo || !collection || !rkey) {
    throw new Error(`Post-flight check failed: malformed published URI "${uri}"`);
  }

  const res = await getRecordFn.call((agent as any).com.atproto.repo, {
    repo,
    collection,
    rkey,
  });
  const val = res?.data?.value as any;
  if (!val || typeof val !== 'object') {
    throw new Error(`Post-flight check failed: empty record value returned for ${uri}`);
  }

  if (replyRefs) {
    const actualParent = val.reply?.parent?.uri;
    const actualRoot = val.reply?.root?.uri;
    if (actualParent !== replyRefs.parent.uri || actualRoot !== replyRefs.root.uri) {
      throw new Error(
        `Post-flight reply mismatch on ${uri}: expected parent=${replyRefs.parent.uri} root=${replyRefs.root.uri}, got parent=${actualParent ?? 'none'} root=${actualRoot ?? 'none'}`
      );
    }
  } else if (val.reply) {
    throw new Error(`Post-flight reply mismatch on ${uri}: expected standalone post, but record.reply is set`);
  }

  const actualEmbedType = val.embed?.$type;
  if (draft.resolvedQuoteUri && draft.imagePaths.length > 0) {
    const actualQuote = val.embed?.record?.record?.uri;
    const actualImages = val.embed?.media?.images?.length ?? 0;
    if (
      actualEmbedType !== 'app.bsky.embed.recordWithMedia' ||
      actualQuote !== draft.resolvedQuoteUri ||
      actualImages !== draft.imagePaths.length
    ) {
      throw new Error(
        `Post-flight embed mismatch on ${uri}: expected recordWithMedia(quote=${draft.resolvedQuoteUri}, images=${draft.imagePaths.length}), got type=${actualEmbedType ?? 'none'} quote=${actualQuote ?? 'none'} images=${actualImages}`
      );
    }
  } else if (draft.resolvedQuoteUri) {
    const actualQuote = val.embed?.record?.uri;
    if (actualEmbedType !== 'app.bsky.embed.record' || actualQuote !== draft.resolvedQuoteUri) {
      throw new Error(
        `Post-flight embed mismatch on ${uri}: expected record(quote=${draft.resolvedQuoteUri}), got type=${actualEmbedType ?? 'none'} quote=${actualQuote ?? 'none'}`
      );
    }
  } else if (draft.imagePaths.length > 0) {
    const actualImages = val.embed?.images?.length ?? 0;
    if (actualEmbedType !== 'app.bsky.embed.images' || actualImages !== draft.imagePaths.length) {
      throw new Error(
        `Post-flight embed mismatch on ${uri}: expected images(${draft.imagePaths.length}), got type=${actualEmbedType ?? 'none'} images=${actualImages}`
      );
    }
  }

  return { verified: true, detail: 'PDS record verified' };
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

export type AgentProvider = () => Agent | null;

const BSKY_CHAT_PROXY_DID = "did:web:api.bsky.chat";

/**
 * Returns an Agent configured with the Bluesky chat service proxy header
 * (`atproto-proxy: did:web:api.bsky.chat#bsky_chat`), falling back to the
 * original agent in test environments where `withProxy` is not stubbed.
 */
function getChatAgent(agent: Agent): Agent {
  if (typeof (agent as any).withProxy === "function") {
    return agent.withProxy("bsky_chat", BSKY_CHAT_PROXY_DID);
  }
  return agent;
}

/**
 * Resolve a handle (e.g., "@alice.bsky.social" or "alice.bsky.social") or DID to a DID.
 */
async function resolveUserDid(agent: Agent, user: string): Promise<string> {
  const cleaned = cleanHandle(user.trim());
  if (!cleaned) {
    throw new Error("User handle or DID cannot be empty.");
  }
  if (cleaned.startsWith("did:")) {
    return cleaned;
  }
  if (typeof (agent as any).resolveHandle === "function") {
    const res = await agent.resolveHandle({ handle: cleaned });
    if (res?.success && res.data?.did) {
      return res.data.did;
    }
  }
  if (typeof (agent as any).getProfile === "function") {
    const profile = await agent.getProfile({ actor: cleaned });
    if (profile?.success && profile.data?.did) {
      return profile.data.did;
    }
  }
  throw new Error(`Could not resolve user handle to DID: ${user}`);
}

/**
 * Resolve a conversation ID either directly from `convoId` or by looking up / creating
 * a 1:1 conversation with `user` via `chat.bsky.convo.getConvoForMembers`.
 */
async function resolveConvo(
  agent: Agent,
  chatAgent: Agent,
  convoId?: string,
  user?: string
): Promise<{ convoId: string; convo?: any }> {
  if (convoId && convoId.trim()) {
    return { convoId: convoId.trim() };
  }
  if (user && user.trim()) {
    const targetDid = await resolveUserDid(agent, user);
    const res = await chatAgent.chat.bsky.convo.getConvoForMembers({
      members: [targetDid],
    });
    if (!res?.success || !res.data?.convo?.id) {
      throw new Error(`Could not find or create a DM conversation with ${user} (${targetDid}).`);
    }
    return { convoId: res.data.convo.id, convo: res.data.convo };
  }
  throw new Error("Provide either 'convoId' or 'user' (handle or DID) to identify the conversation.");
}

function formatDmSender(did: string | undefined, memberMap: Map<string, any>, selfDid?: string): string {
  if (!did) return "Unknown sender";
  const member = memberMap.get(did);
  const youSuffix = selfDid && did === selfDid ? " [You]" : "";
  if (member) {
    const display = member.displayName ? `${member.displayName} ` : "";
    const handle = member.handle ? `@${member.handle}` : did;
    return `${display}(${handle})${youSuffix}`;
  }
  return `${did}${youSuffix}`;
}

function formatDmParticipants(members: any[] | undefined, selfDid?: string): string {
  if (!members || members.length === 0) return "Unknown participants";
  const others = selfDid ? members.filter((m) => m.did !== selfDid) : members;
  const list = others.length > 0 ? others : members;
  return list
    .map((m) => {
      const display = m.displayName ? `${m.displayName} ` : "";
      const handle = m.handle ? `@${m.handle}` : m.did;
      const disabled = m.chatDisabled ? " [chatDisabled]" : "";
      return `${display}(${handle}, ${m.did})${disabled}`;
    })
    .join(", ");
}

function formatDmMessage(msg: any, memberMap: Map<string, any>, selfDid?: string, indent: string = ""): string {
  if (!msg) return `${indent}None`;
  const senderLabel = formatDmSender(msg.sender?.did, memberMap, selfDid);
  const sentAt = msg.sentAt || "unknown time";
  const isDeleted =
    msg.$type === "chat.bsky.convo.defs#deletedMessageView" ||
    (typeof msg.$type === "string" && msg.$type.endsWith("#deletedMessageView"));

  if (isDeleted) {
    return `${indent}[${sentAt}] ${senderLabel} (Message ID: ${msg.id})\n${indent}  [Message deleted]`;
  }

  const text = facetsToMarkdown(msg.text || "", msg.facets);
  const lines: string[] = [
    `${indent}[${sentAt}] ${senderLabel} (Message ID: ${msg.id})`,
    `${indent}  ${text || "(no text)"}`,
  ];

  if (msg.embed) {
    const rec = (msg.embed as any).record;
    const embeddedUri = rec?.uri || rec?.record?.uri;
    const embeddedAuthor = rec?.author?.handle ? `@${rec.author.handle}` : undefined;
    const embeddedText = rec?.value?.text;
    if (embeddedUri) {
      let embedSummary = `${indent}  Embedded Post: ${embeddedUri}`;
      if (embeddedAuthor) embedSummary += ` by ${embeddedAuthor}`;
      if (embeddedText) embedSummary += ` — "${embeddedText}"`;
      lines.push(embedSummary);
    }
  }

  if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
    const reactionList = msg.reactions
      .map((r: any) => `${r.value} (${formatDmSender(r.sender?.did, memberMap, selfDid)})`)
      .join(", ");
    lines.push(`${indent}  Reactions: ${reactionList}`);
  }

  return lines.join("\n");
}

/**
 * Register all Bluesky MCP tools on the provided server.
 * `getAgent` returns the currently authenticated AtpAgent for this session,
 * or null if the caller is not authenticated. It is evaluated per tool call
 * so OAuth-backed sessions can rotate credentials between invocations.
 */
export function registerTools(server: any, getAgent: AgentProvider): void {
  const toolMetadata: Record<
    string,
    {
      title: string;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    }
  > = {
    'get-my-handle-and-did': {
      title: 'Get My Handle and DID',
      annotations: { readOnlyHint: true },
    },
    'get-timeline-posts': {
      title: 'Get Timeline Posts',
      annotations: { readOnlyHint: true },
    },
    'get-notifications': {
      title: 'Get Notifications',
      annotations: { readOnlyHint: true },
    },
    'create-post': {
      title: 'Create Post',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    'create-thread': {
      title: 'Create Thread',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    'delete-post': {
      title: 'Delete Post',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    'get-profile': {
      title: 'Get Profile',
      annotations: { readOnlyHint: true },
    },
    'search-posts': {
      title: 'Search Posts',
      annotations: { readOnlyHint: true },
    },
    'get-posts': {
      title: 'Get Posts',
      annotations: { readOnlyHint: true },
    },
    'get-post-thread': {
      title: 'Get Post Thread',
      annotations: { readOnlyHint: true },
    },
    'get-post-quotes': {
      title: 'Get Post Quotes',
      annotations: { readOnlyHint: true },
    },
    'convert-url-to-uri': {
      title: 'Convert URL to AT URI',
      annotations: { readOnlyHint: true },
    },
    'search-people': {
      title: 'Search People',
      annotations: { readOnlyHint: true },
    },
    'search-feeds': {
      title: 'Search Feeds',
      annotations: { readOnlyHint: true },
    },
    'get-liked-posts': {
      title: 'Get Liked Posts',
      annotations: { readOnlyHint: true },
    },
    'get-trends': {
      title: 'Get Trends',
      annotations: { readOnlyHint: true },
    },
    'like-post': {
      title: 'Like Post',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    'unlike-post': {
      title: 'Unlike Post',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    'repost': {
      title: 'Repost',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    'unrepost': {
      title: 'Unrepost',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    'follow-user': {
      title: 'Follow User',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    'unfollow-user': {
      title: 'Unfollow User',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    'get-pinned-feeds': {
      title: 'Get Pinned Feeds',
      annotations: { readOnlyHint: true },
    },
    'get-feed-posts': {
      title: 'Get Feed Posts',
      annotations: { readOnlyHint: true },
    },
    'get-list-posts': {
      title: 'Get List Posts',
      annotations: { readOnlyHint: true },
    },
    'get-user-posts': {
      title: 'Get User Posts',
      annotations: { readOnlyHint: true },
    },
    'get-follows': {
      title: 'Get Follows',
      annotations: { readOnlyHint: true },
    },
    'get-followers': {
      title: 'Get Followers',
      annotations: { readOnlyHint: true },
    },
    'get-post-likes': {
      title: 'Get Post Likes',
      annotations: { readOnlyHint: true },
    },
    'list-resources': {
      title: 'List Resources',
      annotations: { readOnlyHint: true },
    },
    'list-dm-conversations': {
      title: 'List DM Conversations',
      annotations: { readOnlyHint: true },
    },
    'get-dm-messages': {
      title: 'Get DM Messages',
      annotations: { readOnlyHint: true },
    },
    'send-dm': {
      title: 'Send DM',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    'manage-dm-conversation': {
      title: 'Manage DM Conversation',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    'react-to-dm': {
      title: 'React to DM',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    'delete-dm-message': {
      title: 'Delete DM Message',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
  };

  const registerTool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: any) => Promise<any>
  ) => {
    const meta = toolMetadata[name] || {
      title: name,
      annotations: {},
    };

    if (typeof server.registerTool === "function") {
      server.registerTool(
        name,
        {
          title: meta.title,
          description,
          inputSchema: z.object(schema),
          annotations: meta.annotations,
        },
        handler
      );
    } else if (typeof server.tool === "function") {
      server.tool(name, description, schema, handler);
    }
  };

  registerTool(
    'get-my-handle-and-did',
    'Return the handle and did of the currently authenticated user for this blusesky session. Useful for when someone asks information about themselves using "me" or "my" on bluesky.',
    {},
    async () => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      try {
        const profile = await agent.getProfile({ actor: agent.did });
        return mcpSuccessResponse(`Your handle is: ${profile.data.handle}\nYour did is: ${agent.did}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching profile: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );


  registerTool(
    "get-timeline-posts",
    "Fetch your home timeline from Bluesky, which includes posts from all of the people you follow in reverse chronological order",
    {
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
      includeReposts: z.boolean().default(true).describe("Whether to include reposts in the returned timeline (default: true)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-timeline-posts call"),
    },
    async ({ count, type, detail = "compact", includeReposts = true, cursor: initialCursor }) => {
      try {
        const agent = getAgent();
        if (!agent) {
          return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
        }

        const MAX_TOTAL_POSTS = 500;
        let allPosts: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let shouldContinueFetching = true;

        const useHoursLimit = type === "hours";
        const targetDate = new Date(Date.now() - count * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          const response = await agent.getTimeline({
            limit: 100,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed, cursor } = response.data;
          if (!feed || feed.length === 0) {
            nextCursor = undefined;
            break;
          }

          let filteredFeed = feed;
          if (!includeReposts) {
            filteredFeed = filteredFeed.filter(
              (item) => item?.reason?.$type !== 'app.bsky.feed.defs#reasonRepost'
            );
          }
          if (useHoursLimit) {
            filteredFeed = filteredFeed.filter((item) => {
              const d = getFeedItemTimestamp(item);
              return d ? d >= targetDate : false;
            });
          }

          allPosts = allPosts.concat(filteredFeed);
          nextCursor = cursor;

          if (useHoursLimit) {
            const oldestDate = getFeedItemTimestamp(feed[feed.length - 1]);
            if (oldestDate && oldestDate < targetDate) {
              shouldContinueFetching = false;
            }
          } else {
            shouldContinueFetching = allPosts.length < count;
          }

          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        const finalPosts = !useHoursLimit ? allPosts.slice(0, count) : allPosts;

        if (finalPosts.length === 0) {
          return mcpSuccessResponse("Your timeline is empty.");
        }

        const timelineData = preprocessPosts(finalPosts, { detail, includeReposts });
        const cursorHint = nextCursor && !useHoursLimit ? ` More posts available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(finalPosts.length, "timeline")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${timelineData}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching timeline: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-notifications",
    "Fetch your notifications from Bluesky, optionally filtered by type (reply, mention, like, repost, follow, quote), author, time window, or reply status. Includes inline post text and reply/quote pointers so you don't need separate get-post-thread calls to triage.",
    {
      limit: z.number().min(1).max(500).default(50).describe("Number of notifications to fetch (1-500)"),
      reasons: z.array(z.enum([
        "like",
        "repost",
        "follow",
        "mention",
        "reply",
        "quote",
        "starterpack-joined"
      ])).optional().describe("Filter by notification types (e.g., ['reply', 'mention']). If not provided, returns all types."),
      replyFilter: z.enum(["all", "responded", "unresponded"]).optional().default("all").describe("Filter reply notifications by response status. 'responded' shows only replies you've responded to, 'unresponded' shows only replies you haven't responded to. This filter only applies to notifications with reason 'reply'."),
      authorFilter: z.string().optional().describe("Filter notifications by the handle or DID of the user who triggered them (e.g., 'alice.bsky.social')."),
      hours: z.number().min(0.1).max(720).optional().describe("Optional lookback window in hours (e.g., 24 for the last 24 hours)"),
      since: z.string().optional().describe("Optional ISO-8601 timestamp cutoff; stops fetching notifications older than this time"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-notifications call"),
    },
    async ({ limit, reasons, replyFilter = "all", authorFilter, hours, since, cursor: initialCursor }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        let cutoffDate: Date | null = null;
        if (since) {
          const parsed = new Date(since);
          if (Number.isNaN(parsed.getTime())) {
            return mcpErrorResponse(`Invalid ISO timestamp for 'since': ${since}`);
          }
          cutoffDate = parsed;
        }
        if (hours !== undefined) {
          const hoursCutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
          cutoffDate = cutoffDate && cutoffDate > hoursCutoff ? cutoffDate : hoursCutoff;
        }

        const myDid = agent.did;
        if (replyFilter !== "all" && !myDid) {
          return mcpErrorResponse("Could not determine your DID. Are you authenticated?");
        }

        const targetAuthor = authorFilter ? cleanHandle(authorFilter.trim()).toLowerCase() : null;
        const effectiveReasons = (replyFilter !== "all" && (!reasons || reasons.length === 0)) ? ["reply"] : reasons;

        // Helper to lazily populate repliedToUris down to a target timestamp (paginating PDS records
        // so high-volume accounts with >100 posts/reposts per day don't misclassify answered replies).
        const repliedToUris = new Set<string>();
        let scannedOwnRepliesOldestMs = Infinity;
        let ownRepliesPaginationDone = false;
        let ownRepliesCursor: string | undefined = undefined;
        let ownRepliesPagesFetched = 0;
        const MAX_OWN_REPLY_PAGES = 10; // Up to 1,000 authored posts

        const ensureRepliedToUrisCover = async (targetOldestMs: number) => {
          if (replyFilter === "all" || !myDid) return;
          while (!ownRepliesPaginationDone && scannedOwnRepliesOldestMs > targetOldestMs && ownRepliesPagesFetched < MAX_OWN_REPLY_PAGES) {
            ownRepliesPagesFetched += 1;
            if (typeof agent.com?.atproto?.repo?.listRecords === "function") {
              const res = await agent.com.atproto.repo.listRecords({
                repo: myDid,
                collection: "app.bsky.feed.post",
                limit: 100,
                cursor: ownRepliesCursor,
              });
              if (!res?.success || !res.data.records?.length) {
                ownRepliesPaginationDone = true;
                break;
              }
              for (const rec of res.data.records) {
                const val = rec.value as any;
                if (val?.reply?.parent?.uri) {
                  repliedToUris.add(val.reply.parent.uri);
                }
                if (val?.createdAt) {
                  const ms = new Date(val.createdAt).getTime();
                  if (!Number.isNaN(ms) && ms < scannedOwnRepliesOldestMs) {
                    scannedOwnRepliesOldestMs = ms;
                  }
                }
              }
              ownRepliesCursor = res.data.cursor;
              if (!ownRepliesCursor) ownRepliesPaginationDone = true;
            } else if (typeof agent.app?.bsky?.feed?.getAuthorFeed === "function") {
              const myFeed = await agent.app.bsky.feed.getAuthorFeed({
                actor: myDid,
                limit: 100,
                cursor: ownRepliesCursor,
                filter: "posts_with_replies",
              });
              if (!myFeed?.success || !myFeed.data.feed?.length) {
                ownRepliesPaginationDone = true;
                break;
              }
              for (const item of myFeed.data.feed) {
                const parentUri =
                  (item.post?.record as any)?.reply?.parent?.uri ||
                  (item.reply?.parent && 'uri' in item.reply.parent ? (item.reply.parent as any).uri : undefined);
                if (parentUri) {
                  repliedToUris.add(parentUri);
                }
                const ts = getFeedItemTimestamp(item);
                if (ts && ts.getTime() < scannedOwnRepliesOldestMs) {
                  scannedOwnRepliesOldestMs = ts.getTime();
                }
              }
              ownRepliesCursor = myFeed.data.cursor;
              if (!ownRepliesCursor) ownRepliesPaginationDone = true;
            } else {
              ownRepliesPaginationDone = true;
            }
          }
        };

        const MAX_NOTIFICATIONS = 500;
        let matchedNotifications: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let shouldContinueFetching = true;
        let pagesScanned = 0;
        const MAX_SCAN_PAGES = 15;

        while (
          shouldContinueFetching &&
          matchedNotifications.length < limit &&
          matchedNotifications.length < MAX_NOTIFICATIONS &&
          pagesScanned < MAX_SCAN_PAGES
        ) {
          pagesScanned += 1;
          const response = await agent.app.bsky.notification.listNotifications({
            limit: Math.max(50, Math.min(100, limit - matchedNotifications.length + 10)),
            cursor: nextCursor,
            reasons: effectiveReasons
          });

          if (!response.success) {
            break;
          }

          const { notifications, cursor } = response.data;
          if (!notifications || notifications.length === 0) {
            nextCursor = undefined;
            break;
          }

          // Check if any replies exist in this batch and ensure our own reply scan covers this batch's age
          if (replyFilter !== "all") {
            let batchOldestReplyMs = Infinity;
            for (const n of notifications) {
              if (n.reason === "reply" && n.indexedAt) {
                const ms = new Date(n.indexedAt).getTime();
                if (!Number.isNaN(ms) && ms < batchOldestReplyMs) {
                  batchOldestReplyMs = ms;
                }
              }
            }
            if (batchOldestReplyMs < Infinity) {
              // Give 5 minutes of clock-skew margin
              await ensureRepliedToUrisCover(batchOldestReplyMs - 5 * 60 * 1000);
            }
          }

          let reachedCutoff = false;
          const filtered: any[] = [];
          for (const notif of notifications) {
            if (cutoffDate && notif.indexedAt) {
              const notifDate = new Date(notif.indexedAt);
              if (!Number.isNaN(notifDate.getTime()) && notifDate < cutoffDate) {
                reachedCutoff = true;
                continue;
              }
            }

            if (targetAuthor) {
              const h = (notif.author?.handle || "").toLowerCase();
              const d = (notif.author?.did || "").toLowerCase();
              if (h !== targetAuthor && d !== targetAuthor) {
                continue;
              }
            }

            if (notif.reason !== "reply") {
              if (replyFilter === "all" || (reasons && reasons.includes(notif.reason as any))) {
                filtered.push(notif);
              }
              continue;
            }

            if (replyFilter === "all") {
              filtered.push(notif);
            } else {
              const isResponded = repliedToUris.has(notif.uri);
              if (replyFilter === "responded" ? isResponded : !isResponded) {
                filtered.push(notif);
              }
            }
          }

          matchedNotifications = matchedNotifications.concat(filtered);
          nextCursor = cursor;

          if (reachedCutoff || !cursor) {
            shouldContinueFetching = false;
          } else {
            shouldContinueFetching = matchedNotifications.length < limit;
          }
        }

        const finalNotifications = matchedNotifications.slice(0, limit);

        if (finalNotifications.length === 0) {
          const filterDesc = reasons ? ` with filter: ${reasons.join(', ')}` : '';
          const replyDesc = replyFilter !== 'all' ? ` and reply status: ${replyFilter}` : '';
          const authorDesc = authorFilter ? ` and author: ${authorFilter}` : '';
          const timeDesc = cutoffDate ? ` since ${cutoffDate.toISOString()}` : '';
          return mcpSuccessResponse(`No notifications found${filterDesc}${replyDesc}${authorDesc}${timeDesc}.`);
        }

        const cursorHint = nextCursor && matchedNotifications.length >= limit
          ? ` More notifications available — pass cursor="${nextCursor}" to continue.`
          : '';
        let output = `Retrieved ${finalNotifications.length} notification(s):${cursorHint}\n\n`;

        for (const notif of finalNotifications) {
          const displayName = notif.author.displayName || notif.author.handle;
          let statusLabel = `[${notif.reason.toUpperCase()}]`;

          if (notif.reason === 'reply' && replyFilter !== 'all') {
            statusLabel += ` [${repliedToUris.has(notif.uri) ? 'RESPONDED' : 'UNRESPONDED'}]`;
          }

          output += `${statusLabel} ${displayName} (@${notif.author.handle})\n`;
          output += `  URI: ${notif.uri}\n`;
          if (typeof notif.uri === 'string' && notif.uri.includes('/app.bsky.feed.post/') && notif.author?.handle) {
            const rkey = notif.uri.split('/').pop();
            output += `  URL: https://bsky.app/profile/${notif.author.handle}/post/${rkey}\n`;
          }
          output += `  Time: ${formatIsoTimestamp(notif.indexedAt)}\n`;
          output += `  Read: ${notif.isRead}\n`;
          if (notif.reasonSubject) {
            output += `  Subject: ${notif.reasonSubject}\n`;
          }
          const rec = notif.record as any;
          if (rec?.reply?.parent?.uri) {
            output += `  Reply Parent: ${rec.reply.parent.uri}\n`;
          }
          if (rec?.embed) {
            const quotedUri = rec.embed?.record?.uri || rec.embed?.record?.record?.uri;
            if (quotedUri) {
              output += `  Quoted Post: ${quotedUri}\n`;
            }
          }
          if (typeof rec?.text === 'string' && rec.text.trim()) {
            const formattedText = facetsToMarkdown(rec.text, rec.facets).replace(/\n+/g, '\n    ');
            output += `  Text: ${formattedText}\n`;
          }
          output += `\n`;
        }

        return mcpSuccessResponse(output);
      } catch (error) {
        return mcpErrorResponse(`Error fetching notifications: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "create-post",
    "Create a new post on Bluesky, with support for replies, quote posts, images (including quote + images), and link previews. Enforces Bluesky's exact 300-grapheme limit and fails closed if quoteUri or replyTo cannot be resolved.",
    {
      text: z.string().min(1).max(3000).describe("The content of your post (must be <= 300 graphemes and <= 3000 UTF-8 bytes)"),
      replyTo: z.string().optional().describe("Optional AT URI or Bluesky web URL of the post to reply to"),
      quoteUri: z.string().optional().describe("Optional AT URI or Bluesky web URL of a post to quote (fails closed if target post cannot be resolved)"),
      imagePaths: z.array(z.string()).optional().describe("Optional array of file paths to images (JPEG, PNG, GIF, WebP) to upload and attach (up to 4)"),
      imageAlts: z.array(z.string()).optional().describe("Optional alt text descriptions for the attached images"),
      previewUrl: z.string().url().optional().describe("Optional URL to generate preview card for. If not provided, uses first external URL detected in text."),
      embedPreview: z.boolean().optional().default(true).describe("Whether to fetch and attach a link preview card if no quote post or images are attached. Defaults to true."),
    },
    async ({ text, replyTo, quoteUri, imagePaths, imageAlts, previewUrl, embedPreview = true }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const handleCache = new Map<string, string>();
        let replyRefs: { parent: { uri: string; cid: string }; root: { uri: string; cid: string } } | undefined;

        if (replyTo && replyTo.trim()) {
          const parentTarget = await resolvePostTarget(agent, replyTo, handleCache);
          if ('error' in parentTarget) {
            return mcpErrorResponse(`Error resolving replyTo: ${parentTarget.error}`);
          }
          const parentRecord = parentTarget.post?.record as any;
          const rootUri = parentRecord?.reply?.root?.uri || parentTarget.uri;
          const rootCid = parentRecord?.reply?.root?.cid || parentTarget.cid;
          replyRefs = {
            parent: { uri: parentTarget.uri, cid: parentTarget.cid },
            root: { uri: rootUri, cid: rootCid },
          };
        }

        const prepared = await validateAndPreparePostDraft(
          agent,
          { text, quoteUri, imagePaths, imageAlts, previewUrl, embedPreview },
          handleCache,
          "Post"
        );
        if ('error' in prepared) {
          return mcpErrorResponse(prepared.error);
        }

        const published = await publishPreparedPostDraft(agent, prepared.draft, replyRefs);
        let verificationDetail = 'skipped';
        try {
          const check = await verifyPublishedPostRecord(agent, published.uri, prepared.draft, replyRefs);
          verificationDetail = check.detail;
        } catch (verifyErr) {
          let rollbackStatus = 'rollback unavailable';
          if (typeof (agent as any).deletePost === 'function') {
            try {
              await agent.deletePost(published.uri);
              rollbackStatus = `deleted malformed post ${published.uri}`;
            } catch (delErr) {
              rollbackStatus = `failed to delete ${published.uri}: ${delErr instanceof Error ? delErr.message : String(delErr)}`;
            }
          }
          return mcpErrorResponse(
            `${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)} (${rollbackStatus})`
          );
        }

        const rkey = published.uri.split('/').pop();
        const actor = agent.did || published.uri.split('/')[2];
        const webUrl = `https://bsky.app/profile/${actor}/post/${rkey}`;

        const lines = [
          `Post created successfully!`,
          `URI: ${published.uri}`,
          `CID: ${published.cid}`,
          `URL: ${webUrl}`,
          `Graphemes: ${prepared.draft.graphemeLength}/300`,
          `Embed: ${published.embedSummary}`,
          `Post-Flight: ${verificationDetail}`,
        ];
        if (replyRefs) {
          lines.push(`Reply Parent: ${replyRefs.parent.uri}`);
          lines.push(`Reply Root: ${replyRefs.root.uri}`);
        }

        return mcpSuccessResponse(lines.join('\n'));
      } catch (error) {
        return mcpErrorResponse(`Error creating post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "create-thread",
    "Publish a multi-post Bluesky thread with atomic pre-flight validation, post-flight PDS record verification (reply parent/root & embeds), and automatic rollback on failure. Validates EVERY post's 300-grapheme limit, image file paths (<= 4 per post), and quoteUri targets BEFORE publishing post #1.",
    {
      posts: z.array(
        z.object({
          text: z.string().min(1).max(3000).describe("Post text (<= 300 graphemes)"),
          quoteUri: z.string().optional().describe("Optional AT URI or web URL of a post to quote"),
          imagePaths: z.array(z.string()).optional().describe("Optional image file paths (up to 4)"),
          imageAlts: z.array(z.string()).optional().describe("Optional alt texts matching imagePaths"),
          previewUrl: z.string().url().optional().describe("Optional external URL for link card preview"),
          embedPreview: z.boolean().optional().default(true).describe("Whether to attach external link preview card when no quote or images are present"),
        })
      ).min(1).max(50).describe("Ordered array of posts in the thread (post #1 is the root unless replyTo is provided)"),
      replyTo: z.string().optional().describe("Optional AT URI or web URL of an existing post to attach this thread under as a reply chain"),
      rollbackOnFailure: z.boolean().optional().default(true).describe("If publishing or post-flight verification fails mid-thread, automatically delete already-published posts from this call in reverse order. Defaults to true."),
    },
    async ({ posts, replyTo, rollbackOnFailure = true }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const handleCache = new Map<string, string>();
        let initialRoot: { uri: string; cid: string } | null = null;
        let currentParent: { uri: string; cid: string } | null = null;

        if (replyTo && replyTo.trim()) {
          const parentTarget = await resolvePostTarget(agent, replyTo, handleCache);
          if ('error' in parentTarget) {
            return mcpErrorResponse(`Error resolving replyTo: ${parentTarget.error}`);
          }
          const parentRecord = parentTarget.post?.record as any;
          initialRoot = {
            uri: parentRecord?.reply?.root?.uri || parentTarget.uri,
            cid: parentRecord?.reply?.root?.cid || parentTarget.cid,
          };
          currentParent = { uri: parentTarget.uri, cid: parentTarget.cid };
        }

        // Phase 1: Validate all drafts BEFORE publishing anything
        const preparedDrafts: PreparedPostDraft[] = [];
        for (let i = 0; i < posts.length; i++) {
          const res = await validateAndPreparePostDraft(agent, posts[i], handleCache, `Post #${i + 1}`);
          if ('error' in res) {
            return mcpErrorResponse(`Pre-flight validation failed (0 posts published): ${res.error}`);
          }
          preparedDrafts.push(res.draft);
        }

        // Phase 2: Sequential chained publishing + PDS post-flight verification
        const publishedItems: Array<{
          index: number;
          uri: string;
          cid: string;
          url: string;
          graphemes: number;
          embedSummary: string;
          verified: boolean;
        }> = [];

        for (let i = 0; i < preparedDrafts.length; i++) {
          const draft = preparedDrafts[i];
          const replyRefs =
            currentParent && initialRoot
              ? { parent: currentParent, root: initialRoot }
              : undefined;

          try {
            const pub = await publishPreparedPostDraft(agent, draft, replyRefs);
            const rkey = pub.uri.split('/').pop();
            const actor = agent.did || pub.uri.split('/')[2];
            const item = {
              index: i + 1,
              uri: pub.uri,
              cid: pub.cid,
              url: `https://bsky.app/profile/${actor}/post/${rkey}`,
              graphemes: draft.graphemeLength,
              embedSummary: pub.embedSummary,
              verified: false,
            };
            // Record immediately so rollback cleans it up if post-flight verification throws
            publishedItems.push(item);

            const check = await verifyPublishedPostRecord(agent, pub.uri, draft, replyRefs);
            item.verified = check.verified;

            if (!initialRoot) {
              initialRoot = { uri: pub.uri, cid: pub.cid };
            }
            currentParent = { uri: pub.uri, cid: pub.cid };
          } catch (stepErr) {
            const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
            if (rollbackOnFailure && publishedItems.length > 0 && typeof (agent as any).deletePost === 'function') {
              const deletedUris: string[] = [];
              const failedDeletes: string[] = [];
              for (let j = publishedItems.length - 1; j >= 0; j--) {
                const targetUri = publishedItems[j].uri;
                try {
                  await agent.deletePost(targetUri);
                  deletedUris.push(targetUri);
                } catch (delErr) {
                  failedDeletes.push(`${targetUri} (${delErr instanceof Error ? delErr.message : String(delErr)})`);
                }
              }
              const rollbackSummary =
                failedDeletes.length === 0
                  ? `Rolled back all ${deletedUris.length} published post(s) cleanly.`
                  : `Rolled back ${deletedUris.length} post(s); failed to delete: ${failedDeletes.join(', ')}`;
              return mcpErrorResponse(
                `Error at Post #${i + 1} of ${preparedDrafts.length}: ${errMsg}\n${rollbackSummary}`
              );
            }

            const partialList = publishedItems
              .map((p) => `  #${p.index}: ${p.uri} (${p.url})`)
              .join('\n');
            return mcpErrorResponse(
              `Error publishing Post #${i + 1} of ${preparedDrafts.length}: ${errMsg}\n` +
                (publishedItems.length > 0
                  ? `Already published (${publishedItems.length}):\n${partialList}`
                  : `No posts were published.`)
            );
          }
        }

        const verifiedCount = publishedItems.filter((p) => p.verified).length;
        const verifySummary =
          verifiedCount === publishedItems.length
            ? `PASS (${verifiedCount}/${publishedItems.length} PDS records verified)`
            : `skipped (getRecord unavailable)`;

        const manifest = publishedItems
          .map(
            (p) =>
              `#${p.index} (${p.graphemes}/300 graphemes, embed: ${p.embedSummary})\n  URI: ${p.uri}\n  CID: ${p.cid}\n  URL: ${p.url}`
          )
          .join('\n');

        return mcpSuccessResponse(
          `Thread published successfully (${publishedItems.length} post(s))!\nRoot URI: ${initialRoot?.uri}\nPost-Flight: ${verifySummary}\n\n${manifest}`
        );
      } catch (error) {
        return mcpErrorResponse(`Error creating thread: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "delete-post",
    "Delete a post on Bluesky using its AT URI or web URL",
    {
      postUri: z.string().describe("The AT URI (at://did:.../app.bsky.feed.post/...) or Bluesky web URL (https://bsky.app/profile/.../post/...) of the post to delete"),
    },
    async ({ postUri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const uriToDelete = await normalizePostUri(postUri, agent);
        if (!uriToDelete) {
          return mcpErrorResponse(`Invalid post URI or failed to convert web URL: ${postUri}`);
        }

        await agent.deletePost(uriToDelete);
        return mcpSuccessResponse(`Post deleted successfully! URI: ${uriToDelete}`);
      } catch (error) {
        return mcpErrorResponse(`Error deleting post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-profile",
    "Get a user's profile from Bluesky",
    {
      handle: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
    },
    async ({ handle }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.getProfile({ actor: cleanHandle(handle) });

        if (!response.success) {
          return mcpErrorResponse(`Failed to get profile for ${handle}.`);
        }

        const profile = response.data as any;
        const pronouns = typeof profile.pronouns === 'string' && profile.pronouns.trim() ? profile.pronouns.trim() : '';
        const pinnedUri = typeof profile.pinnedPost?.uri === 'string' && profile.pinnedPost.uri.trim() ? profile.pinnedPost.uri.trim() : '';

        const profileLines = [
          `Profile for ${profile.displayName || handle} (@${profile.handle})`,
          `DID: ${profile.did}`,
        ];
        if (pronouns) profileLines.push(`Pronouns: ${pronouns}`);
        if (profile.description) profileLines.push(`Bio: ${profile.description}`);
        profileLines.push(`Followers: ${profile.followersCount || 0}`);
        profileLines.push(`Following: ${profile.followsCount || 0}`);
        profileLines.push(`Posts: ${profile.postsCount || 0}`);
        if (pinnedUri) profileLines.push(`Pinned Post: ${pinnedUri}`);
        if (profile.labels?.length) {
          profileLines.push(`Labels: ${profile.labels.map((l: any) => l.val).join(', ')}`);
        }

        return mcpSuccessResponse(profileLines.join('\n'));
      } catch (error) {
        return mcpErrorResponse(`Error fetching profile: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "search-posts",
    "Search for posts on Bluesky. Note: Bluesky uses strict AND matching — all search terms must appear in a post. Supported query operators: from:handle, to:handle, mentions:handle, url:domain, lang:code, has:images, has:video, has:link. IMPORTANT: 'to:' and 'mentions:' only match explicit @handle text facets in post text, NOT replies in a thread that omit @handle in the body.",
    {
      query: z.string().describe("Search query (strict AND matching). Operators: from:, to:, mentions:, url:, lang:, has:images, has:video, has:link"),
      limit: z.number().min(1).max(100).default(50).describe("Number of results to fetch (1-100)"),
      sort: z.enum(["top", "latest"]).default("top").describe("Sort order: 'top' (most relevant) or 'latest' (most recent)"),
      since: z.string().optional().describe("Optional ISO-8601 start timestamp inclusive (e.g., '2026-11-10T00:00:00Z')"),
      until: z.string().optional().describe("Optional ISO-8601 end timestamp exclusive (e.g., '2026-11-11T00:00:00Z')"),
      author: z.string().optional().describe("Filter results to posts by this handle or DID"),
      mentions: z.string().optional().describe("Filter results to posts explicitly @mentioning this handle or DID in text"),
      domain: z.string().optional().describe("Filter results to posts linking to this domain (e.g., 'nytimes.com')"),
      url: z.string().optional().describe("Filter results to posts linking to this exact URL"),
      tag: z.array(z.string()).optional().describe("Filter by hashtag(s), without leading '#'"),
      lang: z.string().optional().describe("Filter by 2-letter language code (e.g., 'en')"),
      cursor: z.string().optional().describe("Pagination cursor returned by a previous search-posts call"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
    },
    async ({ query, limit, sort, since, until, author, mentions, domain, url, tag, lang, cursor, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const params: Record<string, any> = { q: query, limit, sort };
        if (since) params.since = since;
        if (until) params.until = until;
        if (author) params.author = cleanHandle(author.trim());
        if (mentions) params.mentions = cleanHandle(mentions.trim());
        if (domain) params.domain = domain.trim();
        if (url) params.url = url.trim();
        if (tag && tag.length > 0) params.tag = tag.map((t: string) => t.replace(/^#/, ''));
        if (lang) params.lang = lang.trim();
        if (cursor) params.cursor = cursor;

        const response = await agent.app.bsky.feed.searchPosts(params as any);

        if (!response.success) {
          return mcpErrorResponse("Failed to search posts.");
        }

        const { posts, cursor: nextCursor } = response.data;

        if (!posts || posts.length === 0) {
          return mcpSuccessResponse(`No results found for query: "${query}"`);
        }

        const feedViewPosts = posts.map(post => ({
          post: post,
          reply: undefined,
          reason: undefined
        }));

        const formattedPosts = preprocessPosts(feedViewPosts, { detail });
        const cursorHint = nextCursor ? ` More results available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(posts.length, "search results")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error searching posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-posts",
    "Batch-hydrate 1 to 25 Bluesky posts in a single API call using their AT URIs or https://bsky.app/... web URLs. Returns full embeds (including quote + media), engagement counts, and explicitly reports any URIs that were deleted or not found.",
    {
      uris: z.array(z.string()).min(1).max(25).describe("Array of 1-25 post AT URIs (at://did:.../app.bsky.feed.post/...) or web URLs (https://bsky.app/profile/.../post/...)"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
    },
    async ({ uris, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const handleCache = new Map<string, string>();
        const normalizedUris: string[] = [];
        const invalidInputs: string[] = [];

        for (const raw of uris) {
          const norm = await normalizePostUri(raw, agent, handleCache);
          if (norm) {
            normalizedUris.push(norm);
          } else {
            invalidInputs.push(raw);
          }
        }

        if (normalizedUris.length === 0) {
          return mcpErrorResponse(`None of the provided post URIs/URLs were valid: ${invalidInputs.join(', ')}`);
        }

        // Deduplicate for API call while preserving input order for output
        const uniqueUris = Array.from(new Set(normalizedUris));
        const res = await agent.app.bsky.feed.getPosts({ uris: uniqueUris });
        if (!res.success) {
          return mcpErrorResponse("Failed to fetch posts.");
        }

        const postByUri = new Map<string, any>();
        for (const p of res.data.posts || []) {
          if (p?.uri) postByUri.set(p.uri, p);
        }

        const foundItems: any[] = [];
        const missingUris: string[] = [];
        for (const u of uniqueUris) {
          const p = postByUri.get(u);
          if (p) {
            foundItems.push({ post: p, reply: undefined, reason: undefined });
          } else {
            missingUris.push(u);
          }
        }

        const headerParts: string[] = [`Hydrated ${foundItems.length}/${uniqueUris.length} requested post(s).`];
        if (missingUris.length > 0) {
          headerParts.push(`Not found / deleted (${missingUris.length}): ${missingUris.join(', ')}`);
        }
        if (invalidInputs.length > 0) {
          headerParts.push(`Invalid inputs (${invalidInputs.length}): ${invalidInputs.join(', ')}`);
        }

        const body = foundItems.length > 0 ? `\n\n${preprocessPosts(foundItems, { detail })}` : '';
        return mcpSuccessResponse(`${headerParts.join('\n')}${body}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-post-thread",
    "Get a conversation thread for a specific post (accepts either an AT URI, including did:plc: and did:web:, or a https://bsky.app/... web URL), showing parent context and nested replies.",
    {
      uri: z.string().describe("AT URI (at://did:.../app.bsky.feed.post/...) or Bluesky web URL (https://bsky.app/profile/.../post/...) of the post"),
      depth: z.number().min(0).max(100).default(6).describe("Levels of reply depth below the requested post to fetch (0-100, default 6)"),
      parentHeight: z.number().min(0).max(100).default(20).describe("Number of ancestor parent posts above the requested post to fetch (0-100, default 20)"),
      maxRepliesPerNode: z.number().min(1).max(200).optional().describe("Optional cap on direct replies rendered per post to keep viral threads concise"),
      detail: z.enum(["compact", "full"]).default("full").describe("Output verbosity: 'full' (XML hierarchy, default) or 'compact' (indented text hierarchy)"),
    },
    async ({ uri, depth = 6, parentHeight = 20, maxRepliesPerNode, detail = "full" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const normalizedUri = await normalizePostUri(uri, agent);
        if (!normalizedUri) {
          return mcpErrorResponse(
            `Invalid post URI or URL: "${uri}". Expected at://did:.../app.bsky.feed.post/... or https://bsky.app/profile/.../post/...`
          );
        }

        const response = await agent.app.bsky.feed.getPostThread({
          uri: normalizedUri,
          depth,
          parentHeight
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to fetch post thread.");
        }

        const threadData = formatPostThread(response.data.thread, { detail, maxRepliesPerNode });
        return mcpSuccessResponse(threadData);
      } catch (error) {
        return mcpErrorResponse(`Error fetching post thread: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-post-quotes",
    "Get posts that quote-post a specific Bluesky post (accepts AT URI or https://bsky.app/... web URL).",
    {
      uri: z.string().describe("AT URI or Bluesky web URL of the quoted post"),
      limit: z.number().min(1).max(100).default(50).describe("Maximum quote-posts to fetch (1-100, default 50)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-post-quotes call"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
    },
    async ({ uri, limit = 50, cursor, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const normalizedUri = await normalizePostUri(uri, agent);
        if (!normalizedUri) {
          return mcpErrorResponse(
            `Invalid post URI or URL: "${uri}". Expected at://did:.../app.bsky.feed.post/... or https://bsky.app/profile/.../post/...`
          );
        }

        const res = await agent.app.bsky.feed.getQuotes({
          uri: normalizedUri,
          limit,
          cursor,
        });

        if (!res.success) {
          return mcpErrorResponse(`Failed to fetch quote posts for ${normalizedUri}.`);
        }

        const { posts, cursor: nextCursor } = res.data;
        if (!posts || posts.length === 0) {
          return mcpSuccessResponse(`No quote posts found for ${normalizedUri}.`);
        }

        const feedItems = posts.map((post: any) => ({ post, reply: undefined, reason: undefined }));
        const formatted = preprocessPosts(feedItems, { detail });
        const cursorHint = nextCursor ? ` More quotes available — pass cursor="${nextCursor}" to continue.` : "";

        return mcpSuccessResponse(`Retrieved ${posts.length} quote post(s) for ${normalizedUri}.${cursorHint}\n\n${formatted}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching quote posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "convert-url-to-uri",
    "Convert a Bluesky web URL to an AT URI format that can be used with other tools",
    {
      url: z.string().describe("Bluesky post URL to convert (e.g., https://bsky.app/profile/username.bsky.social/post/postid)")
    },
    async ({ url }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const atUri = await convertBskyUrlToAtUri(url, agent);

        if (!atUri) {
          return mcpErrorResponse(`Failed to convert URL: ${url}. Make sure it's a valid Bluesky post URL.`);
        }

        return mcpSuccessResponse(`Successfully converted to AT URI: ${atUri}`);
      } catch (error) {
        return mcpErrorResponse(`Error converting URL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "search-people",
    "Search for users/actors on Bluesky",
    {
      query: z.string().describe("Search query for finding users"),
      limit: z.number().min(1).max(100).default(20).describe("Number of results to fetch (1-100)"),
    },
    async ({ query, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.app.bsky.actor.searchActors({ q: query, limit });

        if (!response.success) {
          return mcpErrorResponse("Failed to search for users.");
        }

        const { actors } = response.data;

        if (actors.length === 0) {
          return mcpSuccessResponse(`No users found for query: "${query}"`);
        }

        const results = actors.map((actor: any, index: number) => {
          return `User #${index + 1}:
Display Name: ${actor.displayName || 'No display name'}
Handle: @${actor.handle}
DID: ${actor.did}
${actor.description ? `Bio: ${actor.description}` : 'Bio: No bio provided'}
${actor.followersCount !== undefined ? `Followers: ${actor.followersCount}` : ''}
${actor.followsCount !== undefined ? `Following: ${actor.followsCount}` : ''}
${actor.postsCount !== undefined ? `Posts: ${actor.postsCount}` : ''}
${actor.indexedAt ? `Indexed At: ${new Date(actor.indexedAt).toLocaleString()}` : ''}
---`;
        }).join("\n\n");

        return mcpSuccessResponse(results);
      } catch (error) {
        return mcpErrorResponse(`Error searching for users: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "search-feeds",
    "Search for custom feeds on Bluesky",
    {
      query: z.string().describe("Search query for finding feeds"),
      limit: z.number().min(1).max(100).default(10).describe("Number of results to fetch (1-100)"),
    },
    async ({ query, limit }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const response = await agent.api.app.bsky.unspecced.getPopularFeedGenerators({
          query,
          limit
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to search for feeds.");
        }

        const { feeds } = response.data;

        if (!feeds || feeds.length === 0) {
          return mcpSuccessResponse(`No feeds found for query: "${query}"`);
        }

        const results = feeds.map((feed: any, index: number) => {
          return `Feed #${index + 1}:
Name: ${feed.displayName || 'Unnamed Feed'}
URI: ${feed.uri}
${feed.description ? `Description: ${feed.description}` : ''}
Creator: @${feed.creator.handle} ${feed.creator.displayName ? `(${feed.creator.displayName})` : ''}
Likes: ${feed.likeCount || 0}
${feed.indexedAt ? `Indexed At: ${new Date(feed.indexedAt).toLocaleString()}` : ''}
---`;
        }).join("\n\n");

        return mcpSuccessResponse(results);
      } catch (error) {
        return mcpErrorResponse(`Error searching for feeds: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-liked-posts",
    "Get a list of posts that the authenticated user has liked",
    {
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of liked posts to fetch (1-100)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-liked-posts call"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
    },
    async ({ limit, cursor: initialCursor, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        if (!agent.did) {
          return mcpErrorResponse("Not properly authenticated. Please check your credentials.");
        }

        const authenticatedUser = agent.did;
        const MAX_BATCH_SIZE = 100;
        const MAX_BATCHES = 5;
        let allLikes: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let batchCount = 0;

        while (batchCount < MAX_BATCHES && allLikes.length < limit) {
          const batchLimit = Math.min(MAX_BATCH_SIZE, limit - allLikes.length);

          const response = await agent.app.bsky.feed.getActorLikes({
            actor: authenticatedUser,
            limit: batchLimit,
            cursor: nextCursor || undefined
          });

          if (!response.success) {
            if (allLikes.length > 0) {
              break;
            }
            return mcpErrorResponse(`Failed to fetch your likes.`);
          }

          const { feed, cursor } = response.data;
          allLikes = allLikes.concat(feed);
          nextCursor = cursor;
          batchCount++;

          if (!cursor || allLikes.length >= limit) {
            break;
          }
        }

        if (allLikes.length === 0) {
          return mcpSuccessResponse(`You haven't liked any posts.`);
        }

        const formattedLikes = preprocessPosts(allLikes, { detail });
        const cursorHint = nextCursor ? ` More likes available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(allLikes.length, "liked posts")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedLikes}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching likes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-trends",
    "Get current trending topics on Bluesky",
    {
      limit: z.number().min(1).max(50).default(10).describe("Number of trending topics to fetch (1-50)"),
      includeSuggested: z.boolean().default(false).describe("Whether to include suggested topics in addition to trending topics"),
    },
    async ({ limit, includeSuggested }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const response = await agent.api.app.bsky.unspecced.getTrendingTopics({
          limit: Math.min(50, limit)
        });

        if (!response.success) {
          return mcpErrorResponse("Failed to fetch trending topics.");
        }

        const { topics, suggested } = response.data;

        if (!topics || topics.length === 0) {
          return mcpSuccessResponse("No trending topics found at this time.");
        }

        const formattedTopics = topics.map((topic: any, index: number) => {
          const startTime = formatIsoTimestamp(topic.startTime);
          return `#${index + 1}: ${topic.topic}
Post Count: ${topic.postCount} posts
Started Trending: ${startTime}
Feed Link: https://bsky.app${topic.link}
---`;
        }).join("\n\n");

        let suggestedContent = "";
        if (includeSuggested && suggested && suggested.length > 0) {
          const formattedSuggested = suggested.map((topic: any, index: number) => {
            return `#${index + 1}: ${topic.topic}
Feed Link: https://bsky.app${topic.link}
---`;
          }).join("\n\n");

          suggestedContent = `\n\n## Suggested Topics for Exploration\n\n${formattedSuggested}`;
        }

        return mcpSuccessResponse(`## Current Trending Topics on Bluesky\n\n${formattedTopics}${suggestedContent}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching trending topics: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "like-post",
    "Like a post on Bluesky (accepts AT URI or https://bsky.app/... web URL)",
    {
      uri: z.string().describe("AT URI or Bluesky web URL of the post to like"),
    },
    async ({ uri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const target = await resolvePostTarget(agent, uri);
        if ('error' in target) {
          return mcpErrorResponse(target.error);
        }

        const existingLike = target.post?.viewer?.like;
        if (existingLike) {
          return mcpSuccessResponse(`Post already liked! Post URI: ${target.uri}\nLike Record URI: ${existingLike}`);
        }

        const res = await agent.like(target.uri, target.cid);
        const likeUri = res?.uri ? `\nLike Record URI: ${res.uri}` : '';
        return mcpSuccessResponse(`Post liked successfully! Post URI: ${target.uri}${likeUri}`);
      } catch (error) {
        return mcpErrorResponse(`Error liking post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "unlike-post",
    "Remove a like from a Bluesky post. Pass likeUri (the at://.../app.bsky.feed.like/... record URI) for a direct 1-call delete, or pass postUri (AT URI or web URL of the liked post) to look up and delete your like automatically.",
    {
      postUri: z.string().optional().describe("AT URI or Bluesky web URL of the post to unlike. Mutually exclusive with likeUri."),
      likeUri: z.string().optional().describe("AT URI of your app.bsky.feed.like record (as returned by like-post). Mutually exclusive with postUri."),
    },
    async ({ postUri, likeUri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      if (!postUri && !likeUri) {
        return mcpErrorResponse("Provide either postUri or likeUri.");
      }
      if (postUri && likeUri) {
        return mcpErrorResponse("Provide only one of postUri or likeUri, not both.");
      }

      try {
        let uriToDelete = likeUri?.trim();

        if (uriToDelete) {
          const parts = uriToDelete.split('/');
          if (!uriToDelete.startsWith('at://') || parts.length !== 5 || !parts[2] || !parts[4]) {
            return mcpErrorResponse(`Invalid likeUri format: "${uriToDelete}". Expected at://<did>/app.bsky.feed.like/<rkey>.`);
          }
          if (parts[2] !== agent.did) {
            return mcpErrorResponse(`likeUri belongs to ${parts[2]}, not the authenticated user (${agent.did}).`);
          }
          if (parts[3] !== 'app.bsky.feed.like') {
            return mcpErrorResponse(`likeUri is a ${parts[3]} record, not app.bsky.feed.like.`);
          }
        } else {
          const target = await resolvePostTarget(agent, postUri!);
          if ('error' in target) {
            return mcpErrorResponse(target.error);
          }
          uriToDelete = target.post?.viewer?.like;

          if (!uriToDelete && typeof agent.com?.atproto?.repo?.listRecords === 'function') {
            let cursor: string | undefined;
            for (let page = 0; page < 5 && !uriToDelete; page++) {
              const res = await agent.com.atproto.repo.listRecords({
                repo: agent.did,
                collection: 'app.bsky.feed.like',
                limit: 100,
                cursor,
              });
              if (!res.success || !res.data.records.length) break;
              for (const r of res.data.records) {
                if ((r.value as any)?.subject?.uri === target.uri) {
                  uriToDelete = r.uri;
                  break;
                }
              }
              cursor = res.data.cursor;
              if (!cursor) break;
            }
          }

          if (!uriToDelete) {
            return mcpSuccessResponse(`You have not liked ${target.uri}; nothing to unlike.`);
          }
        }

        await agent.deleteLike(uriToDelete);
        return mcpSuccessResponse(`Unliked post successfully! Deleted like record: ${uriToDelete}`);
      } catch (error) {
        return mcpErrorResponse(`Error unliking post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "repost",
    "Repost a Bluesky post (accepts AT URI or https://bsky.app/... web URL)",
    {
      uri: z.string().describe("AT URI or Bluesky web URL of the post to repost"),
    },
    async ({ uri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const target = await resolvePostTarget(agent, uri);
        if ('error' in target) {
          return mcpErrorResponse(target.error);
        }

        const existingRepost = target.post?.viewer?.repost;
        if (existingRepost) {
          return mcpSuccessResponse(`Post already reposted! Post URI: ${target.uri}\nRepost Record URI: ${existingRepost}`);
        }

        const res = await agent.repost(target.uri, target.cid);
        const repostUri = res?.uri ? `\nRepost Record URI: ${res.uri}` : '';
        return mcpSuccessResponse(`Post reposted successfully! Post URI: ${target.uri}${repostUri}`);
      } catch (error) {
        return mcpErrorResponse(`Error reposting post: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "unrepost",
    "Remove a repost from your Bluesky account. Pass repostUri (your at://.../app.bsky.feed.repost/... record URI) for a direct 1-call delete, or pass postUri (AT URI or web URL of the reposted post) to look up and remove your repost.",
    {
      postUri: z.string().optional().describe("AT URI or Bluesky web URL of the reposted post. Mutually exclusive with repostUri."),
      repostUri: z.string().optional().describe("AT URI of your app.bsky.feed.repost record (as returned by repost). Mutually exclusive with postUri."),
    },
    async ({ postUri, repostUri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      if (!postUri && !repostUri) {
        return mcpErrorResponse("Provide either postUri or repostUri.");
      }
      if (postUri && repostUri) {
        return mcpErrorResponse("Provide only one of postUri or repostUri, not both.");
      }

      try {
        let uriToDelete = repostUri?.trim();

        if (uriToDelete) {
          const parts = uriToDelete.split('/');
          if (!uriToDelete.startsWith('at://') || parts.length !== 5 || !parts[2] || !parts[4]) {
            return mcpErrorResponse(`Invalid repostUri format: "${uriToDelete}". Expected at://<did>/app.bsky.feed.repost/<rkey>.`);
          }
          if (parts[2] !== agent.did) {
            return mcpErrorResponse(`repostUri belongs to ${parts[2]}, not the authenticated user (${agent.did}).`);
          }
          if (parts[3] !== 'app.bsky.feed.repost') {
            return mcpErrorResponse(`repostUri is a ${parts[3]} record, not app.bsky.feed.repost.`);
          }
        } else {
          const target = await resolvePostTarget(agent, postUri!);
          if ('error' in target) {
            return mcpErrorResponse(target.error);
          }
          uriToDelete = target.post?.viewer?.repost;

          if (!uriToDelete && typeof agent.com?.atproto?.repo?.listRecords === 'function') {
            let cursor: string | undefined;
            for (let page = 0; page < 5 && !uriToDelete; page++) {
              const res = await agent.com.atproto.repo.listRecords({
                repo: agent.did,
                collection: 'app.bsky.feed.repost',
                limit: 100,
                cursor,
              });
              if (!res.success || !res.data.records.length) break;
              for (const r of res.data.records) {
                if ((r.value as any)?.subject?.uri === target.uri) {
                  uriToDelete = r.uri;
                  break;
                }
              }
              cursor = res.data.cursor;
              if (!cursor) break;
            }
          }

          if (!uriToDelete) {
            return mcpSuccessResponse(`You have not reposted ${target.uri}; nothing to unrepost.`);
          }
        }

        await agent.deleteRepost(uriToDelete);
        return mcpSuccessResponse(`Removed repost successfully! Deleted repost record: ${uriToDelete}`);
      } catch (error) {
        return mcpErrorResponse(`Error removing repost: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "follow-user",
    "Follow a user on Bluesky",
    {
      handle: z.string().describe("The handle or DID of the user to follow"),
    },
    async ({ handle }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }

      try {
        const did = await resolveUserDid(agent, handle);
        await agent.follow(did);

        return mcpSuccessResponse(`Successfully followed ${handle.startsWith('did:') ? did : `@${cleanHandle(handle)}`}`);
      } catch (error) {
        return mcpErrorResponse(`Error following user: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "unfollow-user",
    "Remove an existing follow from the authenticated user's Bluesky account. Pass followUri (preferred — the at:// URI of your follow record, as returned by get-follows for self) for a direct delete with no extra round trips. If you only have a handle or DID, pass user instead and the tool will scan your follow records to find the matching rkey before deleting.",
    {
      followUri: z.string().optional().describe("The at:// URI of YOUR follow record to delete (e.g., at://did:plc:you/app.bsky.graph.follow/3kabc...). Returned by get-follows for the self path. Mutually exclusive with `user`."),
      user: z.string().optional().describe("The handle or DID of the followee. Used when you don't already have the follow record URI; the tool will list your follow records to find the matching rkey. Mutually exclusive with `followUri`."),
    },
    async ({ followUri, user }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not logged in. Please check your environment variables.");
      }
      if (!agent.did) {
        return mcpErrorResponse("Not authenticated.");
      }
      if (!followUri && !user) {
        return mcpErrorResponse("Provide either followUri or user.");
      }
      if (followUri && user) {
        return mcpErrorResponse("Provide only one of followUri or user, not both.");
      }

      try {
        let uriToDelete = followUri;
        let label = followUri ?? '';

        if (!uriToDelete) {
          // Look up the rkey by scanning the authenticated user's follow
          // records for one whose subject matches the requested followee.
          // Costs one listRecords page (100 records) per ~100 follows the
          // user has; if you already have the URI, prefer that path.
          const profileRes = await agent.getProfile({ actor: cleanHandle(user!) });
          if (!profileRes.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }
          const targetDid = profileRes.data.did;
          if (targetDid === agent.did) {
            return mcpErrorResponse("You can't unfollow yourself.");
          }

          let cursor: string | undefined;
          let foundUri: string | undefined;
          while (!foundUri) {
            const res = await agent.com.atproto.repo.listRecords({
              repo: agent.did,
              collection: 'app.bsky.graph.follow',
              limit: 100,
              cursor,
            });
            if (!res.success) break;
            for (const r of res.data.records) {
              const subject = (r.value as { subject?: unknown })?.subject;
              if (subject === targetDid) {
                foundUri = r.uri;
                break;
              }
            }
            cursor = res.data.cursor;
            if (!cursor || res.data.records.length === 0) break;
          }
          if (!foundUri) {
            return mcpSuccessResponse(`You are not currently following @${user} (${targetDid}); nothing to unfollow.`);
          }
          uriToDelete = foundUri;
          label = `@${profileRes.data.handle} (${targetDid})`;
        } else {
          // Sanity-check that the URI is one of the authenticated user's
          // own follow records. The server would reject foreign URIs, but
          // a clear local error is friendlier than a 4xx surface.
          const parts = uriToDelete.split('/');
          // at://{repo}/{collection}/{rkey} → ['at:', '', repo, collection, rkey]
          const repo = parts[2];
          const collection = parts[3];
          if (repo !== agent.did) {
            return mcpErrorResponse(`followUri belongs to ${repo}, not the authenticated user (${agent.did}). You can only delete your own follow records.`);
          }
          if (collection !== 'app.bsky.graph.follow') {
            return mcpErrorResponse(`followUri is a ${collection} record, not app.bsky.graph.follow.`);
          }
        }

        await agent.deleteFollow(uriToDelete);
        return mcpSuccessResponse(`Unfollowed ${label || uriToDelete}.`);
      } catch (error) {
        return mcpErrorResponse(`Error unfollowing user: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-pinned-feeds",
    "Get the authenticated user's pinned feeds and lists.",
    {},
    async () => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        // Get user preferences which include pinned feeds
        const response = await agent.app.bsky.actor.getPreferences();

        if (!response.success) {
          return mcpErrorResponse("Failed to get user preferences.");
        }

        // Find the savedFeedsPrefV2 in preferences
        const savedFeedsPref = response.data.preferences.find((pref: any) =>
          pref.$type === 'app.bsky.actor.defs#savedFeedsPrefV2'
        ) as { $type: string, items: Array<{ id: string, pinned: boolean, type: string, value: string }> } | undefined;

        if (!savedFeedsPref || !savedFeedsPref.items) {
          return mcpSuccessResponse("No saved feeds found in user preferences.");
        }

        // Get the pinned feeds
        const pinnedFeeds = savedFeedsPref.items.filter((item: any) => item.pinned);

        if (pinnedFeeds.length === 0) {
          return mcpSuccessResponse("You don't have any pinned feeds.");
        }

        // Get additional details for each feed
        const feedDetails = await Promise.all(
          pinnedFeeds.map(async (feed: any) => {
            try {
              // Custom feeds (regular feeds)
              if (feed.type === 'feed' && feed.value) {
                const feedInfo = await agent.app.bsky.feed.getFeedGenerator({
                  feed: feed.value
                });

                if (feedInfo?.success) {
                  return {
                    id: feed.id,
                    uri: feed.value,
                    name: feedInfo.data.view.displayName,
                    description: feedInfo.data.view.description || 'No description',
                    creator: `@${feedInfo.data.view.creator.handle}`,
                    type: 'Custom Feed'
                  };
                }
              }

              // Lists
              else if (feed.type === 'list' && feed.value) {
                const listInfo = await agent.app.bsky.graph.getList({
                  list: feed.value
                });

                if (listInfo?.success) {
                  const list = listInfo.data.list;
                  const memberCount = listInfo.data.items.length;

                  return {
                    id: feed.id,
                    uri: feed.value,
                    name: list.name,
                    description: list.description || 'No description',
                    creator: `@${list.creator.handle}`,
                    members: memberCount,
                    purpose: list.purpose === 'app.bsky.graph.defs#curatelist' ? 'Curated List' :
                            list.purpose === 'app.bsky.graph.defs#modlist' ? 'Moderation List' :
                            'Unknown Purpose',
                    type: 'List'
                  };
                }
              }

              // For built-in feeds or if feed generator info failed
              return {
                id: feed.id,
                uri: feed.value || 'N/A',
                name: getFeedNameFromId(feed.id),
                description: 'Built-in feed',
                creator: 'Bluesky',
                type: feed.type
              };
            } catch (error) {
              return {
                id: feed.id,
                uri: feed.value || 'N/A',
                name: getFeedNameFromId(feed.id),
                description: 'Error fetching details',
                type: feed.type
              };
            }
          })
        );

        const formattedFeeds = feedDetails.map((feed: any, index: number) => {
          // Common fields
          let output = `Feed #${index + 1}:
Name: ${feed.name}
Type: ${feed.type}
${feed.uri !== 'N/A' ? `URI: ${feed.uri}` : ''}
${feed.description ? `Description: ${feed.description}` : ''}
${feed.creator ? `Creator: ${feed.creator}` : ''}`;

          // List-specific fields
          if (feed.type === 'List') {
            output += `\n${feed.members !== undefined ? `Members: ${feed.members}` : ''}
${feed.purpose ? `Purpose: ${feed.purpose}` : ''}`;
          }

          output += '\n---';
          return output;
        }).join("\n\n");

        return mcpSuccessResponse(`Your Pinned Feeds:\n\n${formattedFeeds}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching pinned feeds: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-feed-posts",
    "Fetch posts from a specified custom feed",
    {
      feed: z.string().describe("The URI of the feed to fetch posts from (e.g., at://did:plc:abcdef/app.bsky.feed.generator/whats-hot)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
      includeReposts: z.boolean().default(true).describe("Whether to include reposts (default: true)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-feed-posts call"),
    },
    async ({ feed, count, type, detail = "compact", includeReposts = true, cursor: initialCursor }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const feedInfo = await validateUri(agent, feed, 'feed');
        if (!feedInfo) {
          return mcpErrorResponse(`Invalid feed URI or feed not found: ${feed}.`);
        }

        const MAX_TOTAL_POSTS = 500;
        let allPosts: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let shouldContinueFetching = true;

        const useHoursLimit = type === "hours";
        const targetDate = new Date(Date.now() - count * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          const response = await agent.app.bsky.feed.getFeed({
            feed,
            limit: 100,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed: feedPosts, cursor } = response.data;
          if (!feedPosts || feedPosts.length === 0) {
            nextCursor = undefined;
            break;
          }

          let filteredFeed = feedPosts;
          if (!includeReposts) {
            filteredFeed = filteredFeed.filter(
              (item) => item?.reason?.$type !== 'app.bsky.feed.defs#reasonRepost'
            );
          }
          if (useHoursLimit) {
            filteredFeed = filteredFeed.filter((item) => {
              const d = getFeedItemTimestamp(item);
              return d ? d >= targetDate : false;
            });
          }

          allPosts = allPosts.concat(filteredFeed);
          nextCursor = cursor;

          if (useHoursLimit) {
            const oldestDate = getFeedItemTimestamp(feedPosts[feedPosts.length - 1]);
            if (oldestDate && oldestDate < targetDate) {
              shouldContinueFetching = false;
            }
          } else {
            shouldContinueFetching = allPosts.length < count;
          }

          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        const finalPosts = !useHoursLimit ? allPosts.slice(0, count) : allPosts;

        if (finalPosts.length === 0) {
          return mcpSuccessResponse(`No posts found in the feed: ${feed}`);
        }

        const formattedPosts = preprocessPosts(finalPosts, { detail, includeReposts });
        const cursorHint = nextCursor && !useHoursLimit ? ` More posts available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(finalPosts.length, "feed")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-list-posts",
    "Fetch posts from users in a specified list",
    {
      list: z.string().describe("The URI of the list (e.g., at://did:plc:abcdef/app.bsky.graph.list/listname)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
      includeReposts: z.boolean().default(true).describe("Whether to include reposts (default: true)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-list-posts call"),
    },
    async ({ list, count, type, detail = "compact", includeReposts = true, cursor: initialCursor }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const listInfo = await validateUri(agent, list, 'list');
        if (!listInfo) {
          return mcpErrorResponse(`Invalid list URI or list not found: ${list}.`);
        }

        const MAX_TOTAL_POSTS = 500;
        let allPosts: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let shouldContinueFetching = true;

        const useHoursLimit = type === "hours";
        const targetDate = new Date(Date.now() - count * 60 * 60 * 1000);

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          const response = await agent.app.bsky.feed.getListFeed({
            list,
            limit: 100,
            cursor: nextCursor
          });

          if (!response.success) {
            break;
          }

          const { feed, cursor } = response.data;
          if (!feed || feed.length === 0) {
            nextCursor = undefined;
            break;
          }

          let filteredFeed = feed;
          if (!includeReposts) {
            filteredFeed = filteredFeed.filter(
              (item) => item?.reason?.$type !== 'app.bsky.feed.defs#reasonRepost'
            );
          }
          if (useHoursLimit) {
            filteredFeed = filteredFeed.filter((item) => {
              const d = getFeedItemTimestamp(item);
              return d ? d >= targetDate : false;
            });
          }

          allPosts = allPosts.concat(filteredFeed);
          nextCursor = cursor;

          if (useHoursLimit) {
            const oldestDate = getFeedItemTimestamp(feed[feed.length - 1]);
            if (oldestDate && oldestDate < targetDate) {
              shouldContinueFetching = false;
            }
          } else {
            shouldContinueFetching = allPosts.length < count;
          }

          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        const finalPosts = !useHoursLimit ? allPosts.slice(0, count) : allPosts;

        if (finalPosts.length === 0) {
          return mcpSuccessResponse(`No posts found from the list.`);
        }

        const formattedPosts = preprocessPosts(finalPosts, { detail, includeReposts });
        const cursorHint = nextCursor && !useHoursLimit ? ` More posts available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(finalPosts.length, "list")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching list posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-user-posts",
    "Fetch posts from a specific user. Supports compact (default, ~4x smaller context footprint) or full XML output, repost filtering, cursor pagination, and a 'pds' source mode that reads app.bsky.feed.post records directly from the user's PDS (bypassing AppView reply-visibility filtering, skipping reposts, and preserving URIs of deleted quoted posts while batch-hydrating live metrics).",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      count: z.number().min(1).max(500).describe("Number of posts to fetch or hours to look back"),
      type: z.enum(["posts", "hours"]).describe("Whether count represents number of posts or hours to look back"),
      filter: z.enum([
        "posts_with_replies",
        "posts_no_replies",
        "posts_and_author_threads",
        "posts_with_media",
        "posts_with_video"
      ]).default("posts_with_replies").describe("Filter posts by type (default: posts_with_replies)"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (token-efficient, default) or 'full' (XML)"),
      includeReposts: z.boolean().default(true).describe("Whether to include reposts when source='appview' (default: true). Set false to only return posts authored by the user."),
      source: z.enum(["appview", "pds"]).default("appview").describe("'appview' (default) uses app.bsky.feed.getAuthorFeed; 'pds' reads app.bsky.feed.post records directly from the user's PDS (bypasses AppView reply hiding, excludes reposts, and preserves deleted quote URIs)."),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-user-posts call"),
    },
    async ({ user, count, type, filter = "posts_with_replies", detail = "compact", includeReposts = true, source = "appview", cursor: initialCursor }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        let targetDid: string;
        let authorProfile: any;
        try {
          const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
          if (!profileResponse.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }
          authorProfile = profileResponse.data;
          targetDid = authorProfile.did;
        } catch (profileError) {
          return mcpErrorResponse(`Error retrieving user profile: ${profileError instanceof Error ? profileError.message : String(profileError)}`);
        }

        const MAX_TOTAL_POSTS = 500;
        const useHoursLimit = type === "hours";
        const targetDate = new Date(Date.now() - count * 60 * 60 * 1000);

        if (source === "pds") {
          const isSelf = agent.did === targetDid;
          let repoAgent: Agent | AtpAgent = agent;

          if (!isSelf) {
            const pdsUrl = await resolvePdsEndpoint(targetDid);
            if (!pdsUrl) {
              return mcpErrorResponse(`Could not resolve PDS endpoint from DID document for ${user} (${targetDid}).`);
            }
            repoAgent = new AtpAgent({ service: pdsUrl });
          }

          const rawRecords: Array<{ uri: string; cid: string; value: any }> = [];
          let nextCursor: string | undefined = initialCursor;
          let shouldContinue = true;

          const recordMatchesFilter = (val: any): boolean => {
            if (filter === "posts_no_replies") {
              return !val?.reply;
            }
            if (filter === "posts_and_author_threads") {
              if (!val?.reply) return true;
              const parentDid = typeof val.reply?.parent?.uri === "string" ? val.reply.parent.uri.split("/")[2] : "";
              const rootDid = typeof val.reply?.root?.uri === "string" ? val.reply.root.uri.split("/")[2] : "";
              return parentDid === targetDid && rootDid === targetDid;
            }
            if (filter === "posts_with_media") {
              const t = val?.embed?.$type || "";
              const mt = val?.embed?.media?.$type || "";
              return (
                t === "app.bsky.embed.images" ||
                t === "app.bsky.embed.video" ||
                mt === "app.bsky.embed.images" ||
                mt === "app.bsky.embed.video"
              );
            }
            if (filter === "posts_with_video") {
              const t = val?.embed?.$type || "";
              const mt = val?.embed?.media?.$type || "";
              return t === "app.bsky.embed.video" || mt === "app.bsky.embed.video";
            }
            return true;
          };

          while (shouldContinue && rawRecords.length < MAX_TOTAL_POSTS) {
            const res = await repoAgent.com.atproto.repo.listRecords({
              repo: targetDid,
              collection: "app.bsky.feed.post",
              limit: 100,
              cursor: nextCursor,
            });
            if (!res.success || !res.data.records?.length) {
              nextCursor = undefined;
              break;
            }

            const batch = res.data.records;
            for (const rec of batch) {
              const val = rec.value as any;
              if (useHoursLimit && val?.createdAt) {
                const d = new Date(val.createdAt);
                if (!Number.isNaN(d.getTime()) && d < targetDate) {
                  continue;
                }
              }
              if (recordMatchesFilter(val)) {
                rawRecords.push({ uri: rec.uri, cid: rec.cid, value: val });
              }
            }

            nextCursor = res.data.cursor;
            if (useHoursLimit) {
              const oldest = batch[batch.length - 1]?.value as any;
              if (oldest?.createdAt) {
                const oldestDate = new Date(oldest.createdAt);
                if (!Number.isNaN(oldestDate.getTime()) && oldestDate < targetDate) {
                  shouldContinue = false;
                }
              }
            } else {
              shouldContinue = rawRecords.length < count;
            }
            if (!nextCursor) shouldContinue = false;
          }

          const selectedRecords = !useHoursLimit ? rawRecords.slice(0, count) : rawRecords;
          if (selectedRecords.length === 0) {
            return mcpSuccessResponse(`No posts found from @${authorProfile.handle || user} (via PDS-direct).`);
          }

          // Batch-hydrate live PostViews via AppView getPosts in parallel chunks of 25
          // so we get engagement counts + CDN media URLs while never losing unindexed posts or deleted-quote URIs!
          const hydratedByUri = new Map<string, any>();
          if (typeof agent.app?.bsky?.feed?.getPosts === "function") {
            const CHUNK = 25;
            const chunks: string[][] = [];
            for (let i = 0; i < selectedRecords.length; i += CHUNK) {
              chunks.push(selectedRecords.slice(i, i + CHUNK).map((r) => r.uri));
            }
            const chunkResults = await Promise.all(
              chunks.map(async (uris) => {
                try {
                  const r = await agent.app.bsky.feed.getPosts({ uris });
                  return r.success ? r.data.posts : [];
                } catch {
                  return [];
                }
              })
            );
            for (const posts of chunkResults) {
              for (const p of posts) {
                if (p?.uri) hydratedByUri.set(p.uri, p);
              }
            }
          }

          const feedItems = selectedRecords.map((rec) => {
            const hydrated = hydratedByUri.get(rec.uri);
            if (hydrated) {
              // Ensure raw PDS record is preserved so deleted-target quote URIs in rec.value.embed survive
              return {
                post: { ...hydrated, record: rec.value },
                reply: undefined,
                reason: undefined,
              };
            }
            return {
              post: {
                uri: rec.uri,
                cid: rec.cid,
                author: {
                  did: targetDid,
                  handle: authorProfile.handle || targetDid,
                  displayName: authorProfile.displayName || authorProfile.handle || targetDid,
                },
                record: rec.value,
                indexedAt: rec.value?.createdAt,
              },
              reply: undefined,
              reason: undefined,
            };
          });

          const formattedPosts = preprocessPosts(feedItems, { detail, includeReposts: false });
          const cursorHint = nextCursor && !useHoursLimit ? ` More posts available — pass cursor="${nextCursor}" to continue.` : "";
          const summaryText = `Retrieved ${feedItems.length} authored post(s) from @${authorProfile.handle || user} (via PDS-direct).${cursorHint}`;

          return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
        }

        // Standard AppView path via getAuthorFeed
        let allPosts: any[] = [];
        let nextCursor: string | undefined = initialCursor;
        let shouldContinueFetching = true;

        while (shouldContinueFetching && allPosts.length < MAX_TOTAL_POSTS) {
          const response = await agent.app.bsky.feed.getAuthorFeed({
            actor: targetDid,
            limit: 100,
            cursor: nextCursor,
            filter: filter
          });

          if (!response.success) {
            break;
          }

          const { feed, cursor } = response.data;
          if (!feed || feed.length === 0) {
            nextCursor = undefined;
            break;
          }

          let filteredFeed = feed;
          if (!includeReposts) {
            filteredFeed = filteredFeed.filter(
              (item) => item?.reason?.$type !== 'app.bsky.feed.defs#reasonRepost'
            );
          }
          if (useHoursLimit) {
            filteredFeed = filteredFeed.filter((item) => {
              const d = getFeedItemTimestamp(item);
              return d ? d >= targetDate : false;
            });
          }

          allPosts = allPosts.concat(filteredFeed);
          nextCursor = cursor;

          if (useHoursLimit) {
            const oldestDate = getFeedItemTimestamp(feed[feed.length - 1]);
            if (oldestDate && oldestDate < targetDate) {
              shouldContinueFetching = false;
            }
          } else {
            shouldContinueFetching = allPosts.length < count;
          }

          if (!cursor) {
            shouldContinueFetching = false;
          }
        }

        const finalPosts = !useHoursLimit ? allPosts.slice(0, count) : allPosts;

        if (finalPosts.length === 0) {
          return mcpSuccessResponse(`No posts found from @${user}.`);
        }

        const formattedPosts = preprocessPosts(finalPosts, { detail, includeReposts });
        const cursorHint = nextCursor && !useHoursLimit ? ` More posts available — pass cursor="${nextCursor}" to continue.` : "";
        const summaryText = `${formatSummaryText(finalPosts.length, "user")}${cursorHint}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedPosts}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching user posts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-follows",
    "Get one page of users that a person follows. For the authenticated user's own follows, reads records directly from their PDS (fast when colocated, surfaces the follow record URI needed for unfollow-user, and preserves deactivated/takedown follows that the AppView filters out); otherwise uses the AppView graph.getFollows endpoint. Returns a cursor that should be passed back in to fetch the next page.",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      limit: z.number().min(1).max(500).default(100).describe("Maximum follows to return in this response (1-500). The tool loops the underlying PDS/AppView pagination (100/page) internally to fulfill larger requests. Raise this when you intend to dump the result to a file; keep it small when the output is meant to stay in the model's context."),
      cursor: z.string().optional().describe("Pagination cursor returned by a previous call. Omit on the first call."),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity. 'compact' (default) returns one line per follow with handle, display name, and DID — ~80 bytes per entry. 'full' additionally includes bio and counts; note that at large limits the payload can exceed what some Claude clients will render."),
    },
    async ({ user, limit, cursor, detail }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
        if (!profileResponse.success) {
          return mcpErrorResponse(`User not found: ${user}`);
        }
        const targetDid = profileResponse.data.did;
        const isSelf = agent.did === targetDid;

        const PAGE_SIZE = 100; // Both listRecords and graph.getFollows cap a single call at 100.
        type FollowEntry = { did: string; followUri?: string };
        const follows: FollowEntry[] = [];
        const profileByDid = new Map<string, any>();
        let nextCursor: string | undefined = cursor;

        while (follows.length < limit) {
          const batchLimit = Math.min(PAGE_SIZE, limit - follows.length);
          if (isSelf) {
            // Fast path: read app.bsky.graph.follow records directly from the
            // user's PDS. No AppView aggregation lag, returns the record URI
            // we need to call unfollow-user, and preserves follows of accounts
            // the AppView has filtered out (deactivated/takedown) — exactly
            // the cleanup candidates an unfollow pass wants surfaced.
            const res = await agent.com.atproto.repo.listRecords({
              repo: targetDid,
              collection: 'app.bsky.graph.follow',
              limit: batchLimit,
              cursor: nextCursor,
            });
            if (!res.success) {
              if (follows.length === 0) {
                return mcpErrorResponse(`Failed to list follow records for ${user}.`);
              }
              break;
            }
            for (const r of res.data.records) {
              const subject = (r.value as { subject?: unknown })?.subject;
              if (typeof subject === 'string') {
                follows.push({ did: subject, followUri: r.uri });
              }
            }
            nextCursor = res.data.cursor;
          } else {
            // Other users' graphs go through AppView — we don't host their
            // records. graph.getFollows already returns ProfileView objects;
            // capture them inline so compact rendering needs no hydration.
            const res = await agent.app.bsky.graph.getFollows({
              actor: targetDid,
              limit: batchLimit,
              cursor: nextCursor,
            });
            if (!res.success) {
              if (follows.length === 0) {
                return mcpErrorResponse(`Failed to fetch follows for ${user}.`);
              }
              break;
            }
            for (const f of res.data.follows) {
              follows.push({ did: f.did });
              profileByDid.set(f.did, f);
            }
            nextCursor = res.data.cursor;
          }
          if (!nextCursor) break;
        }

        if (follows.length === 0) {
          return mcpSuccessResponse(`@${user} doesn't follow anyone.`);
        }

        // Hydrate to ProfileViewDetailed via AppView for any DIDs we don't
        // already have. In full-detail mode hydrate everything regardless,
        // because followers/follows/posts counts only exist on the Detailed
        // view (graph.getFollows returns plain ProfileView, no counts).
        // getProfiles caps at 25 actors per call; fire chunks in parallel so
        // hydration cost is one round trip instead of N.
        const toHydrate = detail === "full"
          ? follows.map((f) => f.did)
          : follows.filter((f) => !profileByDid.has(f.did)).map((f) => f.did);
        if (toHydrate.length > 0) {
          const CHUNK = 25;
          const chunks: string[][] = [];
          for (let i = 0; i < toHydrate.length; i += CHUNK) {
            chunks.push(toHydrate.slice(i, i + CHUNK));
          }
          const chunkResults = await Promise.all(chunks.map(async (chunk) => {
            try {
              const res = await agent.app.bsky.actor.getProfiles({ actors: chunk });
              return res.success ? res.data.profiles : [];
            } catch {
              return []; // Any inline ProfileView already in the map survives as fallback.
            }
          }));
          for (const profiles of chunkResults) {
            for (const p of profiles) profileByDid.set(p.did, p);
          }
        }

        const formattedFollows = follows.map(({ did, followUri }, index) => {
          const p = profileByDid.get(did);
          const handle = p?.handle ? `@${p.handle}` : '(handle unresolved)';
          if (detail === "compact") {
            const name = p?.displayName ? ` (${p.displayName})` : "";
            const uri = followUri ? ` [${followUri}]` : "";
            return `${index + 1}. ${handle}${name} — ${did}${uri}`;
          }
          return `User #${index + 1}:
Display Name: ${p?.displayName || 'No display name'}
Handle: ${handle}
DID: ${did}
${followUri ? `Follow Record URI: ${followUri}` : ''}
${p?.description ? `Bio: ${p.description}` : 'Bio: No bio provided'}
${p?.followersCount !== undefined ? `Followers: ${p.followersCount}` : ''}
${p?.followsCount !== undefined ? `Following: ${p.followsCount}` : ''}
${p?.postsCount !== undefined ? `Posts: ${p.postsCount}` : ''}
${p?.indexedAt ? `Indexed at: ${new Date(p.indexedAt).toLocaleString()}` : ''}
---`;
        }).join(detail === "compact" ? "\n" : "\n\n");

        const source = isSelf ? "PDS-direct" : "AppView";
        const uriHint = isSelf ? " The bracketed at:// URI on each line is the follow record; pass it to unfollow-user as followUri to remove that follow without re-resolving the DID." : "";
        const summaryText = `Retrieved ${follows.length} users that @${user} follows (via ${source}).${uriHint}${nextCursor ? ` More pages available — pass cursor="${nextCursor}" to continue.` : ""}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedFollows}`);
      } catch (error) {
        return mcpErrorResponse(`Error fetching follows: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-followers",
    "Get one page of users that follow a person, with compact (default) or full detail and cursor pagination.",
    {
      user: z.string().describe("The handle or DID of the user (e.g., alice.bsky.social)"),
      limit: z.number().min(1).max(500).default(100).describe("Maximum number of followers to fetch (1-500, default 100)"),
      cursor: z.string().optional().describe("Pagination cursor returned by a previous get-followers call"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (~80 bytes/user, default) or 'full' (includes bio & counts)"),
    },
    async ({ user, limit = 100, cursor: initialCursor, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        try {
          const profileResponse = await agent.getProfile({ actor: cleanHandle(user) });
          if (!profileResponse.success) {
            return mcpErrorResponse(`User not found: ${user}`);
          }

          const MAX_BATCH_SIZE = 100;
          const MAX_BATCHES = 5;
          let allFollowers: any[] = [];
          let nextCursor: string | undefined = initialCursor;
          let batchCount = 0;

          while (batchCount < MAX_BATCHES && allFollowers.length < limit) {
            const batchLimit = Math.min(MAX_BATCH_SIZE, limit - allFollowers.length);

            const response = await agent.app.bsky.graph.getFollowers({
              actor: profileResponse.data.did,
              limit: batchLimit,
              cursor: nextCursor
            });

            if (!response.success) {
              if (allFollowers.length > 0) {
                break;
              }
              return mcpErrorResponse(`Failed to fetch followers for ${user}.`);
            }

            const { followers, cursor } = response.data;
            allFollowers = allFollowers.concat(followers);
            nextCursor = cursor;
            batchCount++;

            if (!cursor || allFollowers.length >= limit) {
              break;
            }
          }

          if (allFollowers.length === 0) {
            return mcpSuccessResponse(`@${user} doesn't have any followers.`);
          }

          const formattedFollowers = allFollowers.map((follower: any, index: number) => {
            if (detail === "compact") {
              const name = follower.displayName ? ` (${follower.displayName})` : '';
              return `${index + 1}. @${follower.handle}${name} — ${follower.did}`;
            }
            return `User #${index + 1}:
Display Name: ${follower.displayName || 'No display name'}
Handle: @${follower.handle}
DID: ${follower.did}
${follower.description ? `Bio: ${follower.description}` : 'Bio: No bio provided'}
${follower.followersCount !== undefined ? `Followers: ${follower.followersCount}` : ''}
${follower.followsCount !== undefined ? `Following: ${follower.followsCount}` : ''}
${follower.postsCount !== undefined ? `Posts: ${follower.postsCount}` : ''}
${follower.indexedAt ? `Following since: ${formatIsoTimestamp(follower.indexedAt)}` : ''}
---`;
          }).join(detail === "compact" ? "\n" : "\n\n");

          const summaryText = `Retrieved ${allFollowers.length} followers of @${user}.${nextCursor ? ` More pages available — pass cursor="${nextCursor}" to continue.` : ''}`;

          return mcpSuccessResponse(`${summaryText}\n\n${formattedFollowers}`);

        } catch (profileError) {
          return mcpErrorResponse(`Error retrieving user profile: ${profileError instanceof Error ? profileError.message : String(profileError)}`);
        }
      } catch (error) {
        return mcpErrorResponse(`Error fetching followers: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-post-likes",
    "Get users who liked a specific post (accepts AT URI or https://bsky.app/... web URL)",
    {
      uri: z.string().describe("AT URI or Bluesky web URL of the post"),
      limit: z.number().min(1).max(100).default(100).describe("Maximum number of likes to fetch (1-100)"),
      cursor: z.string().optional().describe("Optional pagination cursor returned by a previous get-post-likes call"),
      detail: z.enum(["compact", "full"]).default("compact").describe("Output verbosity: 'compact' (1 line/user, default) or 'full'"),
    },
    async ({ uri, limit = 100, cursor, detail = "compact" }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const target = await resolvePostTarget(agent, uri);
        if ('error' in target) {
          return mcpErrorResponse(target.error);
        }

        const likesResponse = await agent.app.bsky.feed.getLikes({
          uri: target.uri,
          cid: target.cid,
          limit,
          cursor,
        });

        if (!likesResponse.success) {
          return mcpErrorResponse("Failed to fetch likes for the post.");
        }

        const { likes, cursor: nextCursor } = likesResponse.data;

        if (!likes || likes.length === 0) {
          return mcpSuccessResponse("No likes found for this post.");
        }

        const formattedLikes = likes.map((like: any, index: number) => {
          const actor = like.actor;
          if (detail === "compact") {
            const name = actor.displayName ? ` (${actor.displayName})` : '';
            const ts = like.indexedAt ? ` [${formatIsoTimestamp(like.indexedAt)}]` : '';
            return `${index + 1}. @${actor.handle}${name} — ${actor.did}${ts}`;
          }
          return `User #${index + 1}:
Display Name: ${actor.displayName || 'No display name'}
Handle: @${actor.handle}
DID: ${actor.did}
${actor.description ? `Bio: ${actor.description.substring(0, 100)}${actor.description.length > 100 ? '...' : ''}` : 'Bio: No bio provided'}
${actor.followersCount !== undefined ? `Followers: ${actor.followersCount}` : ''}
${actor.followsCount !== undefined ? `Following: ${actor.followsCount}` : ''}
${actor.postsCount !== undefined ? `Posts: ${actor.postsCount}` : ''}
${like.indexedAt ? `Liked at: ${formatIsoTimestamp(like.indexedAt)}` : ''}
---`;
        }).join(detail === "compact" ? "\n" : "\n\n");

        const summaryText = `Retrieved ${likes.length} likes for ${target.uri}.${nextCursor ? ` More likes available — pass cursor="${nextCursor}" to continue.` : ''}`;

        return mcpSuccessResponse(`${summaryText}\n\n${formattedLikes}`);

      } catch (error) {
        return mcpErrorResponse(`Error fetching post likes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "list-resources",
    "List all available MCP resources with their descriptions",
    {},
    async () => {
      const formattedResources = resourcesList.map((resource, index) => {
        return `Resource #${index + 1}:
Name: ${resource.name}
URI: ${resource.uri}
Description: ${resource.description}
---`;
      }).join("\n\n");

      return mcpSuccessResponse(`Available MCP Resources:\n\n${formattedResources}\n\nTo use these resources, reference them by URI in your prompts or queries.`);
    }
  );

  registerTool(
    "list-dm-conversations",
    "List direct message (DM) conversations for the authenticated user, with optional filters for unread messages or message requests.",
    {
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of conversations to fetch (1-100, default 50)"),
      readState: z.enum(["all", "unread"]).default("all").describe("Filter conversations by read state: 'all' or 'unread' only"),
      status: z.enum(["all", "accepted", "request"]).default("all").describe("Filter by conversation status: 'all', 'accepted', or 'request' (message requests)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous list-dm-conversations response"),
    },
    async ({ limit = 50, readState = "all", status = "all", cursor }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const chatAgent = getChatAgent(agent);
        const queryParams: Record<string, any> = { limit };
        if (cursor) queryParams.cursor = cursor;
        if (readState === "unread") queryParams.readState = "unread";
        if (status !== "all") queryParams.status = status;

        const response = await chatAgent.chat.bsky.convo.listConvos(queryParams);
        if (!response.success) {
          return mcpErrorResponse("Failed to list DM conversations.");
        }

        const { convos, cursor: nextCursor } = response.data;
        if (!convos || convos.length === 0) {
          const filters: string[] = [];
          if (readState !== "all") filters.push(`readState=${readState}`);
          if (status !== "all") filters.push(`status=${status}`);
          const filterSuffix = filters.length > 0 ? ` matching (${filters.join(", ")})` : "";
          return mcpSuccessResponse(`No DM conversations found${filterSuffix}.`);
        }

        const formattedConvos = convos.map((convo: any, idx: number) => {
          const memberMap = new Map<string, any>();
          for (const m of convo.members || []) {
            if (m?.did) memberMap.set(m.did, m);
          }

          const participants = formatDmParticipants(convo.members, agent.did);
          const statusStr = convo.status || "accepted";
          const unreadStr = convo.unreadCount > 0 ? `${convo.unreadCount} unread` : "0 unread";
          const mutedStr = convo.muted ? "Yes" : "No";
          const lastMsgStr = convo.lastMessage
            ? `\nLast Message:\n${formatDmMessage(convo.lastMessage, memberMap, agent.did, "  ")}`
            : "\nLast Message: None";

          return `Conversation #${idx + 1}:
Convo ID: ${convo.id}
Participants: ${participants}
Status: ${statusStr} | Unread: ${unreadStr} | Muted: ${mutedStr}${lastMsgStr}
---`;
        }).join("\n\n");

        const summary = `Retrieved ${convos.length} DM conversation(s).${nextCursor ? ` More conversations available — pass cursor="${nextCursor}" to continue.` : ""}`;
        return mcpSuccessResponse(`${summary}\n\n${formattedConvos}`);
      } catch (error) {
        return mcpErrorResponse(`Error listing DM conversations: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "get-dm-messages",
    "Get direct messages from a conversation, specified by either convoId or a participant's handle/DID. Messages are displayed in chronological order (oldest to newest within the page).",
    {
      convoId: z.string().optional().describe("The ID of the DM conversation. Provide either convoId or user."),
      user: z.string().optional().describe("The handle or DID of the user whose DM conversation to read (e.g., alice.bsky.social). Used if convoId is not provided."),
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of messages to retrieve (1-100, default 50)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous get-dm-messages call to fetch older messages"),
      markRead: z.boolean().optional().default(false).describe("Whether to mark the conversation as read after fetching messages (default: false)"),
    },
    async ({ convoId, user, limit = 50, cursor, markRead = false }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      if ((!convoId || !convoId.trim()) && (!user || !user.trim())) {
        return mcpErrorResponse("Provide either 'convoId' or 'user' (handle or DID) to fetch DM messages.");
      }

      try {
        const chatAgent = getChatAgent(agent);
        const resolved = await resolveConvo(agent, chatAgent, convoId, user);
        const targetConvoId = resolved.convoId;
        let convo = resolved.convo;

        if (!convo && typeof chatAgent.chat?.bsky?.convo?.getConvo === "function") {
          try {
            const convoRes = await chatAgent.chat.bsky.convo.getConvo({ convoId: targetConvoId });
            if (convoRes?.success) {
              convo = convoRes.data.convo;
            }
          } catch {
            // Non-fatal: continue even if convo metadata cannot be hydrated
          }
        }

        const memberMap = new Map<string, any>();
        for (const m of convo?.members || []) {
          if (m?.did) memberMap.set(m.did, m);
        }

        const msgRes = await chatAgent.chat.bsky.convo.getMessages({
          convoId: targetConvoId,
          limit,
          cursor,
        });

        if (!msgRes.success) {
          return mcpErrorResponse(`Failed to retrieve messages for conversation ${targetConvoId}.`);
        }

        if (markRead && typeof chatAgent.chat?.bsky?.convo?.updateRead === "function") {
          try {
            await chatAgent.chat.bsky.convo.updateRead({ convoId: targetConvoId });
          } catch {
            // Non-fatal if markRead fails after reading messages
          }
        }

        const { messages, cursor: nextCursor } = msgRes.data;
        const headerLines: string[] = [`Convo ID: ${targetConvoId}`];
        if (convo?.members) {
          headerLines.push(`Participants: ${formatDmParticipants(convo.members, agent.did)}`);
        }
        if (convo?.status) {
          headerLines.push(`Status: ${convo.status} | Unread: ${markRead ? 0 : (convo.unreadCount ?? 0)}`);
        }

        if (!messages || messages.length === 0) {
          return mcpSuccessResponse(`${headerLines.join("\n")}\n\nNo messages in this conversation.`);
        }

        // API returns newest-first; reverse so reading flows oldest -> newest chronologically
        const chronological = [...messages].reverse();
        const formattedMessages = chronological
          .map((m) => formatDmMessage(m, memberMap, agent.did))
          .join("\n\n");

        const cursorHint = nextCursor ? `\nOlder messages available — pass cursor="${nextCursor}" to fetch earlier history.` : "";
        return mcpSuccessResponse(
          `Retrieved ${messages.length} message(s) from conversation ${targetConvoId}.${cursorHint}\n${headerLines.join("\n")}\n\n${formattedMessages}`
        );
      } catch (error) {
        return mcpErrorResponse(`Error fetching DM messages: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "send-dm",
    "Send or reply to a direct message (DM) on Bluesky. Specify the target conversation by convoId or by the recipient's user handle/DID. Supports rich text (links, @mentions, #hashtags) and optional post quoting.",
    {
      text: z.string().min(1).max(1000).describe("The text content of the direct message (1-1000 characters)"),
      convoId: z.string().optional().describe("The conversation ID to send the message to. Provide either convoId or user."),
      user: z.string().optional().describe("The handle or DID of the recipient (e.g., alice.bsky.social or did:plc:...). Used if convoId is not provided."),
      quoteUri: z.string().optional().describe("Optional AT URI or Bluesky web URL of a post to embed/share in the DM"),
    },
    async ({ text, convoId, user, quoteUri }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      if (!text || !text.trim()) {
        return mcpErrorResponse("Message text cannot be empty.");
      }

      if ((!convoId || !convoId.trim()) && (!user || !user.trim())) {
        return mcpErrorResponse("Provide either 'convoId' or 'user' (handle or DID) to specify the DM recipient.");
      }

      try {
        const chatAgent = getChatAgent(agent);
        const { convoId: targetConvoId } = await resolveConvo(agent, chatAgent, convoId, user);

        const rt = new RichText({ text });
        try {
          await rt.detectFacets(agent);
        } catch {
          // If facet resolution fails (e.g. unresolvable handle), send plain text
        }

        const messageInput: Record<string, any> = {
          text: rt.text,
        };

        if (rt.facets && rt.facets.length > 0) {
          messageInput.facets = rt.facets;
        }

        if (quoteUri && quoteUri.trim()) {
          let targetUri = quoteUri.trim();
          if (targetUri.startsWith("http://") || targetUri.startsWith("https://")) {
            const converted = await convertBskyUrlToAtUri(targetUri, agent);
            if (!converted) {
              return mcpErrorResponse(`Failed to convert post URL to AT URI: ${quoteUri}`);
            }
            targetUri = converted;
          }
          const threadRes = await agent.app.bsky.feed.getPostThread({ uri: targetUri });
          const post = (threadRes?.data?.thread as any)?.post;
          if (!threadRes?.success || !post?.cid) {
            return mcpErrorResponse(`Could not resolve post to embed: ${quoteUri}`);
          }
          messageInput.embed = {
            $type: "app.bsky.embed.record",
            record: {
              uri: targetUri,
              cid: post.cid,
            },
          };
        }

        const res = await chatAgent.chat.bsky.convo.sendMessage({
          convoId: targetConvoId,
          message: messageInput as any,
        });

        if (!res.success) {
          return mcpErrorResponse(`Failed to send DM to conversation ${targetConvoId}.`);
        }

        const sent = res.data;
        return mcpSuccessResponse(
          `DM sent successfully!\nConvo ID: ${targetConvoId}\nMessage ID: ${sent.id}\nSent At: ${sent.sentAt}\nText: ${sent.text}`
        );
      } catch (error) {
        return mcpErrorResponse(`Error sending DM: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "manage-dm-conversation",
    "Manage a Bluesky DM conversation: mark as read, mark all conversations as read, accept a message request, leave a conversation, or mute/unmute notifications.",
    {
      action: z
        .enum(["mark-read", "mark-all-read", "accept", "leave", "mute", "unmute"])
        .describe("Action to perform: 'mark-read', 'mark-all-read', 'accept' (accept message request), 'leave', 'mute', or 'unmute'"),
      convoId: z
        .string()
        .optional()
        .describe("The conversation ID (required for all actions except 'mark-all-read', unless user is provided)"),
      user: z
        .string()
        .optional()
        .describe("Handle or DID of the user in the conversation, used if convoId is not provided"),
      messageId: z
        .string()
        .optional()
        .describe("Optional message ID up to which to mark as read (only used with 'mark-read')"),
      status: z
        .enum(["accepted", "request"])
        .optional()
        .describe("Optional conversation status filter when using 'mark-all-read' ('accepted' or 'request')"),
    },
    async ({ action, convoId, user, messageId, status }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      try {
        const chatAgent = getChatAgent(agent);

        if (action === "mark-all-read") {
          const res = await chatAgent.chat.bsky.convo.updateAllRead(status ? { status } : {});
          if (!res.success) {
            return mcpErrorResponse("Failed to mark conversations as read.");
          }
          return mcpSuccessResponse(
            `Marked all${status ? ` (${status})` : ""} conversations as read. Updated count: ${res.data.updatedCount}`
          );
        }

        if ((!convoId || !convoId.trim()) && (!user || !user.trim())) {
          return mcpErrorResponse(`Provide either 'convoId' or 'user' for action '${action}'.`);
        }

        const { convoId: targetConvoId } = await resolveConvo(agent, chatAgent, convoId, user);

        switch (action) {
          case "mark-read": {
            const res = await chatAgent.chat.bsky.convo.updateRead({
              convoId: targetConvoId,
              ...(messageId ? { messageId } : {}),
            });
            if (!res.success) {
              return mcpErrorResponse(`Failed to mark conversation ${targetConvoId} as read.`);
            }
            return mcpSuccessResponse(`Conversation ${targetConvoId} marked as read.`);
          }
          case "accept": {
            const res = await chatAgent.chat.bsky.convo.acceptConvo({ convoId: targetConvoId });
            if (!res.success) {
              return mcpErrorResponse(`Failed to accept conversation ${targetConvoId}.`);
            }
            return mcpSuccessResponse(
              `Conversation ${targetConvoId} accepted.${res.data.rev ? ` (rev: ${res.data.rev})` : " (already accepted)"}`
            );
          }
          case "leave": {
            const res = await chatAgent.chat.bsky.convo.leaveConvo({ convoId: targetConvoId });
            if (!res.success) {
              return mcpErrorResponse(`Failed to leave conversation ${targetConvoId}.`);
            }
            return mcpSuccessResponse(`Left conversation ${targetConvoId}.`);
          }
          case "mute": {
            const res = await chatAgent.chat.bsky.convo.muteConvo({ convoId: targetConvoId });
            if (!res.success) {
              return mcpErrorResponse(`Failed to mute conversation ${targetConvoId}.`);
            }
            return mcpSuccessResponse(`Muted conversation ${targetConvoId}.`);
          }
          case "unmute": {
            const res = await chatAgent.chat.bsky.convo.unmuteConvo({ convoId: targetConvoId });
            if (!res.success) {
              return mcpErrorResponse(`Failed to unmute conversation ${targetConvoId}.`);
            }
            return mcpSuccessResponse(`Unmuted conversation ${targetConvoId}.`);
          }
        }
      } catch (error) {
        return mcpErrorResponse(`Error managing DM conversation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "react-to-dm",
    "Add or remove an emoji reaction on a direct message in a Bluesky conversation.",
    {
      messageId: z.string().min(1).describe("The ID of the direct message to react to"),
      reaction: z.string().min(1).describe("The emoji reaction value (e.g., '❤️', '👍', '😂', '🔥')"),
      convoId: z.string().optional().describe("The conversation ID containing the message. Provide either convoId or user."),
      user: z.string().optional().describe("Handle or DID of the user in the conversation, used if convoId is not provided."),
      remove: z.boolean().optional().default(false).describe("Set to true to remove the reaction instead of adding it (default: false)"),
    },
    async ({ messageId, reaction, convoId, user, remove = false }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      if ((!convoId || !convoId.trim()) && (!user || !user.trim())) {
        return mcpErrorResponse("Provide either 'convoId' or 'user' (handle or DID) to identify the conversation.");
      }

      try {
        const chatAgent = getChatAgent(agent);
        const { convoId: targetConvoId } = await resolveConvo(agent, chatAgent, convoId, user);

        if (remove) {
          const res = await chatAgent.chat.bsky.convo.removeReaction({
            convoId: targetConvoId,
            messageId: messageId.trim(),
            value: reaction,
          });
          if (!res.success) {
            return mcpErrorResponse(`Failed to remove reaction ${reaction} from message ${messageId}.`);
          }
          return mcpSuccessResponse(`Removed reaction ${reaction} from message ${messageId} in conversation ${targetConvoId}.`);
        } else {
          const res = await chatAgent.chat.bsky.convo.addReaction({
            convoId: targetConvoId,
            messageId: messageId.trim(),
            value: reaction,
          });
          if (!res.success) {
            return mcpErrorResponse(`Failed to add reaction ${reaction} to message ${messageId}.`);
          }
          return mcpSuccessResponse(`Added reaction ${reaction} to message ${messageId} in conversation ${targetConvoId}.`);
        }
      } catch (error) {
        return mcpErrorResponse(`Error updating DM reaction: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  registerTool(
    "delete-dm-message",
    "Delete a direct message from the authenticated user's view in a Bluesky conversation (deleteMessageForSelf).",
    {
      messageId: z.string().min(1).describe("The ID of the direct message to delete"),
      convoId: z.string().optional().describe("The conversation ID containing the message. Provide either convoId or user."),
      user: z.string().optional().describe("Handle or DID of the user in the conversation, used if convoId is not provided."),
    },
    async ({ messageId, convoId, user }) => {
      const agent = getAgent();
      if (!agent) {
        return mcpErrorResponse("Not connected to Bluesky. Check your environment variables.");
      }

      if ((!convoId || !convoId.trim()) && (!user || !user.trim())) {
        return mcpErrorResponse("Provide either 'convoId' or 'user' (handle or DID) to identify the conversation.");
      }

      try {
        const chatAgent = getChatAgent(agent);
        const { convoId: targetConvoId } = await resolveConvo(agent, chatAgent, convoId, user);

        const res = await chatAgent.chat.bsky.convo.deleteMessageForSelf({
          convoId: targetConvoId,
          messageId: messageId.trim(),
        });

        if (!res.success) {
          return mcpErrorResponse(`Failed to delete message ${messageId} in conversation ${targetConvoId}.`);
        }

        return mcpSuccessResponse(`Deleted message ${messageId} for yourself in conversation ${targetConvoId}.`);
      } catch (error) {
        return mcpErrorResponse(`Error deleting DM message: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
