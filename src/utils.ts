import { Agent } from "@atproto/api";
import { RichText } from '@atproto/api'



/**
 * Represents a text content item in an MCP response.
 * This is the most basic type of content that can be returned.
 */
export interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

/**
 * Represents an image content item in an MCP response.
 * Contains the image data as a base64 string and its MIME type.
 */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  [key: string]: unknown;
}

/**
 * Represents a resource content item in an MCP response.
 * Can contain either a text-based resource with URI or a blob-based resource.
 * Used for linking to external content or providing structured data.
 */
export interface ResourceContent {
  type: "resource";
  resource: {
    text: string;
    uri: string;
    mimeType?: string;
    [key: string]: unknown;
  } | {
    uri: string;
    blob: string;
    mimeType?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Union type representing all possible content types that can be included in an MCP response.
 * Can be a text content, image content, or resource content.
 */
export type McpResponseContent = Array<TextContent | ImageContent | ResourceContent>;

/**
 * Represents a successful response from the MCP server.
 * Contains an array of content items that can be of any supported type.
 */
export interface McpSuccessResponse {
  content: McpResponseContent;
  [key: string]: unknown;
}

/**
 * Represents an error response from the MCP server.
 * Contains an error flag and an array of content items explaining the error.
 */
export interface McpErrorResponse {
  isError: true;
  content: McpResponseContent;
  [key: string]: unknown;
}

export function mcpLog(message: string): void {
  if (process.env.LOG_RESPONSES === 'true') {
    // See https://modelcontextprotocol.io/docs/tools/debugging - we should use the server.sendLoggingMessage method, but it is not working for some reason
    console.error(message);
  }
}

/**
 * Defense in depth against content-based tool-output rejection.
 *
 * Anthropic publishes a canary string whose sole purpose is to trip its
 * safety classifiers — `ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_` followed
 * by a hex digest. When a Bluesky user slips one into a bio, a post, a
 * profile description, etc., any tool that surfaces that text back
 * through Claude produces an empty/redacted tool_result client-side,
 * which appears to the user as a 60s "timed out" with no content.
 *
 * Since this server relays arbitrary user-generated content, one cheeky
 * follow is enough to break tools like `get-follows`, `get-profile`,
 * `get-timeline-posts`, etc. Scrub the literal pattern at the response
 * boundary so it can't reach the classifier. This is not a general
 * censorship hook — it targets exactly the published canary.
 */
const REFUSAL_CANARY_RE = /ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_[A-Za-z0-9]+/g;

export function redactRefusalCanary(text: string): string {
  return text.replace(REFUSAL_CANARY_RE, '[redacted: refusal-trigger canary]');
}

export function mcpErrorResponse(message: string): McpErrorResponse {
  const scrubbed = redactRefusalCanary(message);
  mcpLog(scrubbed);
  return {
    isError: true,
    content: [{
      type: "text",
      text: scrubbed
    }]
  };
}

export function mcpSuccessResponse(text: string): McpSuccessResponse {
  const scrubbed = redactRefusalCanary(text);
  mcpLog(scrubbed);
  return {
    content: [{
      type: "text",
      text: scrubbed
    }]
  };
}


/**
 * Helper function to get a human-readable name for built-in feeds
 */
export function getFeedNameFromId(id: string): string {
  const knownFeeds: Record<string, string> = {
    'home': 'Home Timeline',
    'following': 'Following',
    'what-hot': 'What\'s Hot',
    'discover': 'Discover',
    'for-you': 'For You'
  };
  
  return knownFeeds[id] || id;
}

/**
 * Cleans a handle or DID string
 * @param input A string that could be a DID or handle (potentially with @ prefix)
 * @returns The cleaned handle with @ removed or the original DID
 */
export function cleanHandle(input: string): string {
  if (!input) return '';
  
  // If it's a DID, return it as is
  if (input.startsWith('did:')) {
    return input;
  }
  
  // If it has a leading @, remove it
  if (input.startsWith('@')) {
    return input.substring(1);
  }
  
  // Otherwise return as is
  return input;
}


/**
 * Convert Bluesky post text + facets into Markdown
 * @param text The post text content
 * @param facets Optional array of facets from the post
 * @param options Optional formatting flags (e.g. xmlSafe to escape XML entities)
 * @returns Markdown formatted text with proper links and mentions
 */
export function facetsToMarkdown(
  text: string,
  facets?: any[],
  options?: { xmlSafe?: boolean }
): string {
  if (!text) return '';

  let markdown = '';
  try {
    const rt = new RichText({ text, facets: facets ?? [] });
    for (const segment of rt.segments()) {
      if (segment.isLink() && segment.link?.uri) {
        const uri = segment.link.uri;
        const strippedText = segment.text.replace(/^https?:\/\//i, '').replace(/\.{2,}$|…$/u, '');
        const strippedUri = uri.replace(/^https?:\/\//i, '');
        if (!segment.text || strippedUri.startsWith(strippedText)) {
          markdown += uri;
        } else {
          markdown += `[${segment.text}](${uri})`;
        }
      } else if (segment.isMention() && segment.mention?.did) {
        markdown += `[${segment.text}](https://bsky.app/profile/${segment.mention.did})`;
      } else if (segment.isTag() && segment.tag?.tag) {
        markdown += `#${segment.tag.tag}`;
      } else {
        markdown += segment.text;
      }
    }
  } catch {
    markdown = text;
  }

  return options?.xmlSafe ? escapeXml(markdown) : markdown;
}

/**
 * Formats any timestamp string/Date into a canonical ISO-8601 UTC string.
 * Falls back to the original string if parsing fails.
 */
export function formatIsoTimestamp(dateInput?: string | Date | null): string {
  if (!dateInput) return '';
  try {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(d.getTime())) {
      return typeof dateInput === 'string' ? dateInput : '';
    }
    return d.toISOString();
  } catch {
    return typeof dateInput === 'string' ? dateInput : '';
  }
}



/**
 * Format the summary text for the response
 */
export function formatSummaryText(postsCount: number, entityType: string = 'feed'): string {
  return `Retrieved ${postsCount} posts from the ${entityType}.`;
}


/**
 * Validate a feed or list URI by fetching its information
 * @param agent The ATP agent instance
 * @param uri The feed or list URI to validate
 * @param type The type of URI ('feed' or 'list')
 * @returns The feed/list information or null if invalid
 */
export async function validateUri(
  agent: Agent, 
  uri: string, 
  type: 'feed' | 'list'
): Promise<any | null> {
  try {
    let response;
    
    if (type === 'list' || uri.includes('app.bsky.graph.list')) {
      response = await agent.app.bsky.graph.getList({ list: uri });
    } else {
      response = await agent.app.bsky.feed.getFeedGenerator({ feed: uri });
    }
    
    if (!response.success) {
      return null;
    }
    
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Debugs the structure of a post to see where facets are stored
 * This is a temporary function to help with development
 */
export function debugPostStructure(post: any): void {
  console.error('DEBUG POST STRUCTURE:');
  console.error('Post has record:', !!post.record);
  
  if (post.record) {
    console.error('Record properties:', Object.keys(post.record));
    console.error('Has facets:', !!post.record.facets);
    
    if (post.record.facets) {
      console.error('First facet:', JSON.stringify(post.record.facets[0], null, 2));
    }
  }
  
  // Check if facets might be at another location
  console.error('Post properties:', Object.keys(post));
  console.error('Has facets at root:', !!post.facets);
  
  if (post.facets) {
    console.error('First facet at root:', JSON.stringify(post.facets[0], null, 2));
  }
}

/**
 * Helper function to escape XML special characters and strip control bytes
 * that are illegal in XML 1.0 (`0x00-0x08`, `0x0B`, `0x0C`, `0x0E-0x1F`, `0xFFFE`, `0xFFFF`).
 * @param unsafe The string to escape
 * @returns Well-formed XML-safe string
 */
export function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  // eslint-disable-next-line no-control-regex
  return unsafe
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse a Bluesky web URL and extract the handle and rkey
 * @param url The Bluesky web URL (e.g., https://bsky.app/profile/username.bsky.social/post/postid)
 * @returns An object containing the handle and rkey, or null if the URL is invalid
 */
export function parseBskyUrl(url: string): { handle: string, rkey: string } | null {
  try {
    // Remove any @ prefix if provided
    const cleanUrl = url.trim().replace(/^@/, '');
    
    // Match patterns like https://bsky.app/profile/username.bsky.social/post/postid
    const regex = /https?:\/\/bsky\.app\/profile\/([^\/]+)\/post\/([^\/\?#]+)/;
    const match = cleanUrl.match(regex);
    
    if (!match) return null;
    
    return {
      handle: match[1],
      rkey: match[2]
    };
  } catch (error) {
    return null;
  }
}

const AT_POST_URI_RE = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]+)$/;

/**
 * Check whether a string is a valid AT URI for a Bluesky post (supports did:plc:, did:web:, etc.)
 */
export function isValidPostAtUri(uri: string): boolean {
  return AT_POST_URI_RE.test(uri.trim());
}

/**
 * Convert a Bluesky post URL to an AT URI
 * @param url The Bluesky web URL (e.g., https://bsky.app/profile/username.bsky.social/post/postid)
 * @param agent The Agent instance to use for handle resolution
 * @param handleCache Optional handle -> DID cache for batch conversions
 * @returns The AT URI or null if conversion failed
 */
export async function convertBskyUrlToAtUri(
  url: string,
  agent: Agent,
  handleCache?: Map<string, string>
): Promise<string | null> {
  try {
    const parsed = parseBskyUrl(url);
    if (!parsed) return null;

    const actor = cleanHandle(parsed.handle);
    let did: string | undefined;

    if (actor.startsWith('did:')) {
      did = actor;
    } else if (handleCache?.has(actor.toLowerCase())) {
      did = handleCache.get(actor.toLowerCase());
    } else {
      const resolveResponse = await agent.resolveHandle({ handle: actor });
      if (!resolveResponse.success || !resolveResponse.data?.did) {
        return null;
      }
      did = resolveResponse.data.did;
      handleCache?.set(actor.toLowerCase(), did);
    }

    if (!did) return null;
    return `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
  } catch {
    return null;
  }
}

/**
 * Normalize either an AT post URI (did:plc / did:web) or a Bluesky web URL into an AT post URI.
 */
export async function normalizePostUri(
  input: string,
  agent: Agent,
  handleCache?: Map<string, string>
): Promise<string | null> {
  if (!input) return null;
  const trimmed = input.trim().replace(/^@/, '');
  if (isValidPostAtUri(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return await convertBskyUrlToAtUri(trimmed, agent, handleCache);
  }
  return null;
}

const pdsEndpointCache = new Map<string, { endpoint: string; expiresAt: number }>();
const PDS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve the ATProto PDS base URL (e.g. https://inkcap.us-east.host.bsky.network)
 * from a user's DID document (`did:plc:` via plc.directory or `did:web:` via .well-known/did.json).
 */
export async function resolvePdsEndpoint(did: string): Promise<string | null> {
  const cached = pdsEndpointCache.get(did);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.endpoint;
  }

  let didDocUrl: string;
  if (did.startsWith('did:plc:')) {
    didDocUrl = `https://plc.directory/${encodeURIComponent(did)}`;
  } else if (did.startsWith('did:web:')) {
    const rawDomain = did.slice('did:web:'.length);
    const parts = rawDomain.split(':').map(decodeURIComponent);
    if (parts.length === 1) {
      didDocUrl = `https://${parts[0]}/.well-known/did.json`;
    } else {
      didDocUrl = `https://${parts[0]}/${parts.slice(1).join('/')}/did.json`;
    }
  } else {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(didDocUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const doc = (await res.json()) as {
        service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
      };
      const svc = doc.service?.find(
        (s) =>
          s.id === '#atproto_pds' ||
          (typeof s.id === 'string' && s.id.endsWith('#atproto_pds')) ||
          s.type === 'AtprotoPersonalDataServer'
      );
      if (!svc?.serviceEndpoint || typeof svc.serviceEndpoint !== 'string') {
        return null;
      }
      const endpoint = svc.serviceEndpoint.replace(/\/+$/, '');
      pdsEndpointCache.set(did, { endpoint, expiresAt: Date.now() + PDS_CACHE_TTL_MS });
      return endpoint;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Extract the first URL from text
 * Returns null if no URL found
 */
export function extractFirstUrl(text: string): string | null {
  // URL regex that handles common patterns
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  const match = text.match(urlRegex);
  return match ? match[0] : null;
}
