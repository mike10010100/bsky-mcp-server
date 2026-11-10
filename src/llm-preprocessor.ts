// Implements the spec described in /POST_FORMAT_SPEC.md (plus compact mode)
import type {
  AppBskyFeedDefs,
  AppBskyEmbedImages,
  AppBskyEmbedVideo,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyFeedPost,
} from '@atproto/api';
import { escapeXml, facetsToMarkdown, formatIsoTimestamp } from './utils.js';

export { facetsToMarkdown };

export interface PreprocessOptions {
  detail?: 'compact' | 'full';
  includeReposts?: boolean;
}

export interface ThreadFormatOptions {
  detail?: 'compact' | 'full';
  maxRepliesPerNode?: number;
}

interface NormalizedQuote {
  status: 'ok' | 'not_found' | 'blocked' | 'detached' | 'unhydrated';
  uri: string;
  bskyUrl?: string;
  authorHandle?: string;
  authorName?: string;
  postedAt?: string;
  text?: string;
  facets?: any[];
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  mediaSummary?: NormalizedMedia[];
}

type NormalizedMedia =
  | {
      kind: 'image';
      alt: string;
      url: string;
    }
  | {
      kind: 'link';
      title: string;
      url: string;
      description: string;
      thumb?: string;
    }
  | {
      kind: 'video';
      alt?: string;
      playlist?: string;
      thumbnail?: string;
      url?: string;
    };

/**
 * Creates a Bluesky web URL from an AT post URI and optional handle.
 */
function createBskyUrl(uri: string, handle?: string): string {
  try {
    if (!uri) return '';
    const parts = uri.split('/');
    const did = parts[2];
    const rkey = parts[parts.length - 1];
    if (!did || !rkey) return '';
    return `https://bsky.app/profile/${handle || did}/post/${rkey}`;
  } catch {
    return '';
  }
}

/**
 * Extract media items from an embed view (or raw embed record fallback).
 */
function extractMediaOnly(embed: any, authorDid?: string): NormalizedMedia[] {
  if (!embed || typeof embed !== 'object') return [];
  const type = typeof embed.$type === 'string' ? embed.$type : '';
  const items: NormalizedMedia[] = [];

  // Hydrated Views
  if (type === 'app.bsky.embed.images#view' && Array.isArray(embed.images)) {
    for (const img of embed.images as AppBskyEmbedImages.ViewImage[]) {
      if (!img) continue;
      items.push({
        kind: 'image',
        alt: img.alt || '',
        url: img.fullsize || img.thumb || '',
      });
    }
  } else if (type === 'app.bsky.embed.external#view' && embed.external) {
    const ext = (embed as AppBskyEmbedExternal.View).external;
    items.push({
      kind: 'link',
      title: ext.title || '',
      url: ext.uri || '',
      description: ext.description || '',
      thumb: ext.thumb || undefined,
    });
  } else if (type === 'app.bsky.embed.video#view' || type.includes('embed.video#view')) {
    const vid = embed.video || (embed as AppBskyEmbedVideo.View);
    items.push({
      kind: 'video',
      alt: vid.alt || embed.alt || undefined,
      thumbnail: vid.thumbnail || vid.thumb || embed.thumbnail || undefined,
      playlist: vid.playlist || embed.playlist || undefined,
      url: vid.url || undefined,
    });
  }
  // Raw Record Fallbacks (e.g. unhydrated PDS records)
  else if (type === 'app.bsky.embed.images' && Array.isArray(embed.images)) {
    for (const img of embed.images) {
      if (!img) continue;
      const cid = img.image?.ref?.$link || img.image?.cid || '';
      const fallbackUrl =
        authorDid && cid
          ? `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${cid}@jpeg`
          : cid
            ? `blob:${cid}`
            : '';
      items.push({
        kind: 'image',
        alt: img.alt || '',
        url: fallbackUrl,
      });
    }
  } else if (type === 'app.bsky.embed.external' && embed.external) {
    items.push({
      kind: 'link',
      title: embed.external.title || '',
      url: embed.external.uri || '',
      description: embed.external.description || '',
    });
  } else if (type === 'app.bsky.embed.video') {
    const cid = embed.video?.ref?.$link || embed.video?.cid || '';
    items.push({
      kind: 'video',
      alt: embed.alt || undefined,
      playlist:
        authorDid && cid
          ? `https://video.bsky.app/watch/${encodeURIComponent(authorDid)}/${cid}/playlist.m3u8`
          : undefined,
    });
  }

  return items;
}

/**
 * Normalize an embedded record view (or raw record pointer) into a NormalizedQuote.
 */
function normalizeEmbeddedRecord(recordContainer: any, rawRecordFallback?: any): NormalizedQuote | null {
  const rec = recordContainer?.record ?? recordContainer;
  const fallbackUri: string =
    rawRecordFallback?.record?.uri ||
    rawRecordFallback?.uri ||
    rec?.uri ||
    '';

  if (!rec || typeof rec !== 'object') {
    if (fallbackUri) {
      return { status: 'unhydrated', uri: fallbackUri, bskyUrl: createBskyUrl(fallbackUri) };
    }
    return null;
  }

  const rType = typeof rec.$type === 'string' ? rec.$type : '';

  if (rType === 'app.bsky.embed.record#viewRecord' || (rec.uri && rec.author && rec.value)) {
    const viewRec = rec as AppBskyEmbedRecord.ViewRecord;
    const val = (viewRec.value || {}) as { text?: string; createdAt?: string; facets?: any[] };
    const nestedMedia: NormalizedMedia[] = [];
    if (Array.isArray(viewRec.embeds)) {
      for (const e of viewRec.embeds) {
        if ((e as any)?.$type === 'app.bsky.embed.recordWithMedia#view') {
          nestedMedia.push(...extractMediaOnly((e as any).media, viewRec.author?.did));
        } else {
          nestedMedia.push(...extractMediaOnly(e, viewRec.author?.did));
        }
      }
    }
    return {
      status: 'ok',
      uri: viewRec.uri,
      bskyUrl: createBskyUrl(viewRec.uri, viewRec.author?.handle),
      authorHandle: viewRec.author?.handle || '',
      authorName: viewRec.author?.displayName || viewRec.author?.handle || '',
      postedAt: formatIsoTimestamp(val.createdAt || viewRec.indexedAt),
      text: val.text || '',
      facets: val.facets,
      likeCount: viewRec.likeCount ?? 0,
      repostCount: viewRec.repostCount ?? 0,
      replyCount: viewRec.replyCount ?? 0,
      quoteCount: viewRec.quoteCount ?? 0,
      mediaSummary: nestedMedia.length > 0 ? nestedMedia : undefined,
    };
  }

  if (rType === 'app.bsky.embed.record#viewNotFound' || rec.notFound) {
    const uri = rec.uri || fallbackUri;
    return uri ? { status: 'not_found', uri, bskyUrl: createBskyUrl(uri) } : null;
  }

  if (rType === 'app.bsky.embed.record#viewBlocked' || rec.blocked) {
    const uri = rec.uri || fallbackUri;
    return uri ? { status: 'blocked', uri, bskyUrl: createBskyUrl(uri) } : null;
  }

  if (rType === 'app.bsky.embed.record#viewDetached' || rec.detached) {
    const uri = rec.uri || fallbackUri;
    return uri ? { status: 'detached', uri, bskyUrl: createBskyUrl(uri) } : null;
  }

  // Raw ATProto record pointer: { uri, cid }
  if (typeof rec.uri === 'string' && rec.uri.startsWith('at://')) {
    return {
      status: 'unhydrated',
      uri: rec.uri,
      bskyUrl: createBskyUrl(rec.uri),
    };
  }

  if (fallbackUri) {
    return { status: 'unhydrated', uri: fallbackUri, bskyUrl: createBskyUrl(fallbackUri) };
  }

  return null;
}

/**
 * Extract both quoted post (if any) and media attachments (if any) from a PostView,
 * handling `record#view`, `recordWithMedia#view`, and raw PDS `record.embed` structures.
 */
function extractQuoteAndMedia(post: any): { quote: NormalizedQuote | null; media: NormalizedMedia[] } {
  const viewEmbed = post?.embed;
  const rawEmbed = post?.record?.embed;
  const authorDid: string | undefined = post?.author?.did || (typeof post?.uri === 'string' ? post.uri.split('/')[2] : undefined);

  let quote: NormalizedQuote | null = null;
  let media: NormalizedMedia[] = [];

  if (viewEmbed && typeof viewEmbed === 'object') {
    const vType = typeof viewEmbed.$type === 'string' ? viewEmbed.$type : '';

    if (vType === 'app.bsky.embed.recordWithMedia#view') {
      const rawRecFallback = rawEmbed?.$type === 'app.bsky.embed.recordWithMedia' ? rawEmbed.record : rawEmbed;
      quote = normalizeEmbeddedRecord(viewEmbed.record, rawRecFallback);
      media = extractMediaOnly(viewEmbed.media, authorDid);
    } else if (vType === 'app.bsky.embed.record#view') {
      quote = normalizeEmbeddedRecord(viewEmbed, rawEmbed);
    } else {
      media = extractMediaOnly(viewEmbed, authorDid);
    }
  }

  // Fallback to raw record.embed if viewEmbed was absent or missing pieces
  if (rawEmbed && typeof rawEmbed === 'object') {
    const rType = typeof rawEmbed.$type === 'string' ? rawEmbed.$type : '';
    if (!quote) {
      if (rType === 'app.bsky.embed.recordWithMedia' && rawEmbed.record) {
        quote = normalizeEmbeddedRecord(rawEmbed.record, rawEmbed.record);
      } else if (rType === 'app.bsky.embed.record' && rawEmbed.record) {
        quote = normalizeEmbeddedRecord(rawEmbed.record, rawEmbed);
      }
    }
    if (media.length === 0) {
      if (rType === 'app.bsky.embed.recordWithMedia' && rawEmbed.media) {
        media = extractMediaOnly(rawEmbed.media, authorDid);
      } else if (rType !== 'app.bsky.embed.record') {
        media = extractMediaOnly(rawEmbed, authorDid);
      }
    }
  }

  return { quote, media };
}

/**
 * Render NormalizedMedia items as XML `<embed>` elements.
 */
function renderMediaXml(media: NormalizedMedia[], indent: string): string {
  let out = '';
  for (const m of media) {
    if (m.kind === 'image') {
      out += `${indent}<embed type="image">\n`;
      out += `${indent}  Image description: "${escapeXml(m.alt || 'No description provided')}"\n`;
      if (m.url) {
        out += `${indent}  URL: ${escapeXml(m.url)}\n`;
      }
      out += `${indent}</embed>\n`;
    } else if (m.kind === 'link') {
      out += `${indent}<embed type="link">\n`;
      if (m.title) out += `${indent}  Title: "${escapeXml(m.title)}"\n`;
      if (m.url) out += `${indent}  URL: ${escapeXml(m.url)}\n`;
      if (m.description) out += `${indent}  Description: "${escapeXml(m.description)}"\n`;
      if (m.thumb) out += `${indent}  Thumbnail: ${escapeXml(m.thumb)}\n`;
      out += `${indent}</embed>\n`;
    } else if (m.kind === 'video') {
      out += `${indent}<embed type="video">\n`;
      if (m.alt) out += `${indent}  Video description: "${escapeXml(m.alt)}"\n`;
      if (m.thumbnail) out += `${indent}  Thumbnail: ${escapeXml(m.thumbnail)}\n`;
      if (m.playlist) out += `${indent}  Playlist: ${escapeXml(m.playlist)}\n`;
      if (m.url) out += `${indent}  URL: ${escapeXml(m.url)}\n`;
      out += `${indent}</embed>\n`;
    }
  }
  return out;
}

/**
 * Render NormalizedQuote as an XML `<quoted_post>` element.
 */
function renderQuoteXml(quote: NormalizedQuote, indent: string): string {
  if (quote.status !== 'ok') {
    const bskyAttr = quote.bskyUrl ? ` bsky_url="${escapeXml(quote.bskyUrl)}"` : '';
    return `${indent}<quoted_post uri="${escapeXml(quote.uri)}"${bskyAttr} status="${escapeXml(quote.status)}" />\n`;
  }

  let out = `${indent}<quoted_post uri="${escapeXml(quote.uri)}" bsky_url="${escapeXml(quote.bskyUrl || '')}" author_name="${escapeXml(quote.authorName || '')}" author_handle="${escapeXml(quote.authorHandle || '')}" posted_at="${escapeXml(quote.postedAt || '')}">\n`;
  out += `${indent}  <content>\n${indent}    ${facetsToMarkdown(quote.text || '', quote.facets, { xmlSafe: true })}\n${indent}  </content>\n`;
  if (quote.mediaSummary && quote.mediaSummary.length > 0) {
    out += renderMediaXml(quote.mediaSummary, `${indent}  `);
  }
  out += `${indent}  Engagement: ${quote.likeCount ?? 0} likes, ${quote.repostCount ?? 0} reposts, ${quote.replyCount ?? 0} replies${quote.quoteCount ? `, ${quote.quoteCount} quotes` : ''}\n`;
  out += `${indent}</quoted_post>\n`;
  return out;
}

/**
 * Render NormalizedMedia items in compact text lines.
 */
function renderMediaCompact(media: NormalizedMedia[], indent: string): string[] {
  const lines: string[] = [];
  for (const m of media) {
    if (m.kind === 'image') {
      const cleanAlt = m.alt ? m.alt.replace(/\s+/g, ' ').trim() : '';
      const shortAlt = cleanAlt.length > 240 ? `${cleanAlt.slice(0, 240)}…` : cleanAlt;
      const altPart = shortAlt ? ` (alt: "${shortAlt}")` : '';
      lines.push(`${indent}media: [image] ${m.url}${altPart}`);
    } else if (m.kind === 'link') {
      const titlePart = m.title ? ` "${m.title.replace(/\s+/g, ' ').trim()}"` : '';
      lines.push(`${indent}media: [link]${titlePart} ${m.url}`);
    } else if (m.kind === 'video') {
      const cleanAlt = m.alt ? m.alt.replace(/\s+/g, ' ').trim() : '';
      const shortAlt = cleanAlt.length > 240 ? `${cleanAlt.slice(0, 240)}…` : cleanAlt;
      const altPart = shortAlt ? ` (alt: "${shortAlt}")` : '';
      lines.push(`${indent}media: [video] ${m.playlist || m.url || m.thumbnail || ''}${altPart}`);
    }
  }
  return lines;
}

/**
 * Render NormalizedQuote in compact text lines.
 */
function renderQuoteCompact(quote: NormalizedQuote, indent: string): string[] {
  if (quote.status !== 'ok') {
    return [`${indent}quote: [${quote.status}] ${quote.uri}`];
  }
  const cleanText = facetsToMarkdown(quote.text || '', quote.facets).replace(/\n+/g, ' ⏎ ').trim();
  const lines = [
    `${indent}quote: @${quote.authorHandle} (${quote.uri}, ${quote.postedAt || 'unknown'}) — "${cleanText}"`,
  ];
  if (quote.mediaSummary && quote.mediaSummary.length > 0) {
    lines.push(...renderMediaCompact(quote.mediaSummary, `${indent}  `));
  }
  return lines;
}

/**
 * Extract reply parent & root URIs from either record.reply or feedItem.reply.
 */
function extractReplyRefs(post: any, replyView?: any): { parentUri?: string; rootUri?: string } {
  const record = post?.record as AppBskyFeedPost.Record | undefined;
  const parentUri: string | undefined =
    record?.reply?.parent?.uri ||
    (replyView?.parent && typeof replyView.parent === 'object' && 'uri' in replyView.parent
      ? (replyView.parent as any).uri
      : undefined);
  const rootUri: string | undefined =
    record?.reply?.root?.uri ||
    (replyView?.root && typeof replyView.root === 'object' && 'uri' in replyView.root
      ? (replyView.root as any).uri
      : undefined);
  return { parentUri, rootUri };
}

/**
 * Format a single PostView as XML at a given indentation level, with optional pre-rendered `<replies>` children.
 */
function renderPostXml(
  post: any,
  options: {
    indentLevel: number;
    replyView?: any;
    isRequestedPost?: boolean;
    childrenXml?: string;
  }
): string {
  if (!post || !post.uri) return '';
  const indent = '  '.repeat(options.indentLevel);
  const record = (post.record || {}) as AppBskyFeedPost.Record;
  const { parentUri, rootUri } = extractReplyRefs(post, options.replyView);
  const { quote, media } = extractQuoteAndMedia(post);

  const types: string[] = [record.reply || parentUri ? 'reply' : 'standalone'];
  if (quote) {
    types.push('quote');
  }

  const handle = post.author?.handle || '';
  const displayName = post.author?.displayName || handle;
  const bskyUrl = createBskyUrl(post.uri, handle);
  const createdIso = formatIsoTimestamp(record.createdAt || post.indexedAt);
  const indexedIso = formatIsoTimestamp(post.indexedAt);

  let attrs = `type="${escapeXml(types.join(','))}" uri="${escapeXml(post.uri)}" bsky_url="${escapeXml(bskyUrl)}" author_name="${escapeXml(displayName)}" author_handle="${escapeXml(handle)}" posted_at="${escapeXml(createdIso)}"`;

  // Surface server indexed_at when client clock skew exceeds 60 seconds
  if (record.createdAt && post.indexedAt) {
    const diffMs = Math.abs(new Date(post.indexedAt).getTime() - new Date(record.createdAt).getTime());
    if (!Number.isNaN(diffMs) && diffMs > 60_000) {
      attrs += ` indexed_at="${escapeXml(indexedIso)}"`;
    }
  }

  if (parentUri) {
    attrs += ` reply_to="${escapeXml(parentUri)}"`;
  }
  if (rootUri && rootUri !== parentUri) {
    attrs += ` root_uri="${escapeXml(rootUri)}"`;
  }
  if (options.isRequestedPost) {
    attrs += ` requested="true"`;
  }

  let out = `${indent}<post ${attrs}>\n`;
  out += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets, { xmlSafe: true })}\n${indent}  </content>\n`;

  if (quote) {
    out += renderQuoteXml(quote, `${indent}  `);
  }
  if (media.length > 0) {
    out += renderMediaXml(media, `${indent}  `);
  }

  const likes = post.likeCount ?? 0;
  const reposts = post.repostCount ?? 0;
  const replies = post.replyCount ?? 0;
  const quotes = post.quoteCount ?? 0;
  if (post.likeCount !== undefined || post.repostCount !== undefined || post.replyCount !== undefined) {
    out += `${indent}  Engagement: ${likes} likes, ${reposts} reposts, ${replies} replies${quotes ? `, ${quotes} quotes` : ''}\n`;
  }

  if (options.childrenXml) {
    out += `${indent}  <replies>\n${options.childrenXml}${indent}  </replies>\n`;
  }

  out += `${indent}</post>\n`;
  return out;
}

/**
 * Format a single PostView in compact text format at a given indentation depth.
 */
function renderPostCompact(
  post: any,
  options: {
    depth: number;
    replyView?: any;
    isRequestedPost?: boolean;
    repostBy?: { handle: string; displayName?: string; indexedAt?: string };
    childrenCompact?: string;
  }
): string {
  if (!post || !post.uri) return '';
  const indent = '  '.repeat(options.depth);
  const prefix = options.depth > 0 ? '↳ ' : '';
  const record = (post.record || {}) as AppBskyFeedPost.Record;
  const { parentUri, rootUri } = extractReplyRefs(post, options.replyView);
  const { quote, media } = extractQuoteAndMedia(post);

  const handle = post.author?.handle || post.author?.did || 'unknown';
  const namePart =
    post.author?.displayName && post.author.displayName !== handle
      ? ` (${post.author.displayName})`
      : '';
  const createdIso = formatIsoTimestamp(record.createdAt || post.indexedAt);
  const reqTag = options.isRequestedPost ? ' [REQUESTED]' : '';
  const repostTag = options.repostBy
    ? ` [REPOST by @${options.repostBy.handle} at ${formatIsoTimestamp(options.repostBy.indexedAt)}]`
    : '';

  const lines: string[] = [];
  lines.push(`${indent}${prefix}[${createdIso}] @${handle}${namePart} — ${post.uri}${reqTag}${repostTag}`);

  const bodyIndent = `${indent}  `;
  if (parentUri) {
    const rootPart = rootUri && rootUri !== parentUri ? ` | root: ${rootUri}` : '';
    lines.push(`${bodyIndent}reply_to: ${parentUri}${rootPart}`);
  }

  const text = facetsToMarkdown(record.text || '', record.facets);
  if (text) {
    for (const textLine of text.split('\n')) {
      lines.push(`${bodyIndent}${textLine}`);
    }
  } else {
    lines.push(`${bodyIndent}(no text)`);
  }

  if (quote) {
    lines.push(...renderQuoteCompact(quote, bodyIndent));
  }
  if (media.length > 0) {
    lines.push(...renderMediaCompact(media, bodyIndent));
  }

  const l = post.likeCount ?? 0;
  const rp = post.repostCount ?? 0;
  const r = post.replyCount ?? 0;
  const q = post.quoteCount ?? 0;
  if (l > 0 || rp > 0 || r > 0 || q > 0) {
    lines.push(`${bodyIndent}metrics: ${l}L ${rp}RP ${r}R${q ? ` ${q}Q` : ''}`);
  }

  let block = lines.join('\n');
  if (options.childrenCompact) {
    block += `\n${options.childrenCompact}`;
  }
  return block;
}

interface FeedTreeNode {
  kind: 'post';
  uri: string;
  item: AppBskyFeedDefs.FeedViewPost;
  createdMs: number;
  children: FeedTreeNode[];
}

type TopLevelEntry =
  | { kind: 'repost'; item: AppBskyFeedDefs.FeedViewPost }
  | FeedTreeNode;

/**
 * Build a lossless forest from FeedViewPost items:
 * - Reposts stay top-level `<repost>` items (unless excluded).
 * - Non-repost items attach to `parentUri` ONLY when `parentUri` is actually present
 *   in `feedItems` (preventing orphaned deep replies from ever being dropped!).
 * - Any reply whose immediate parent is not in `feedItems` is emitted at the top level
 *   with `reply_to` and `root_uri` preserved, and any of its own descendants in `feedItems`
 *   nest cleanly underneath it.
 */
function buildFeedForest(
  feedItems: AppBskyFeedDefs.FeedViewPost[],
  includeReposts: boolean
): TopLevelEntry[] {
  const byUri = new Map<string, FeedTreeNode>();
  const orderedCandidates: Array<{ kind: 'repost'; item: AppBskyFeedDefs.FeedViewPost } | { kind: 'node'; node: FeedTreeNode }> = [];

  for (const item of feedItems) {
    if (!item?.post?.uri) continue;
    const isRepost = item.reason?.$type === 'app.bsky.feed.defs#reasonRepost';

    if (isRepost) {
      if (includeReposts) {
        orderedCandidates.push({ kind: 'repost', item });
      }
      continue;
    }

    if (byUri.has(item.post.uri)) {
      continue; // Deduplicate identical post URIs within the same batch
    }

    const rec = item.post.record as AppBskyFeedPost.Record | undefined;
    const ts = rec?.createdAt || item.post.indexedAt || '';
    const ms = ts ? new Date(ts).getTime() : 0;
    const node: FeedTreeNode = {
      kind: 'post',
      uri: item.post.uri,
      item,
      createdMs: Number.isNaN(ms) ? 0 : ms,
      children: [],
    };
    byUri.set(node.uri, node);
    orderedCandidates.push({ kind: 'node', node });
  }

  const attachedUris = new Set<string>();

  for (const node of byUri.values()) {
    const { parentUri } = extractReplyRefs(node.item.post, node.item.reply);
    if (parentUri && parentUri !== node.uri && byUri.has(parentUri)) {
      // Guard against pathological cycles
      let cursor: FeedTreeNode | undefined = byUri.get(parentUri);
      let hasCycle = false;
      while (cursor) {
        if (cursor.uri === node.uri) {
          hasCycle = true;
          break;
        }
        const nextParent = extractReplyRefs(cursor.item.post, cursor.item.reply).parentUri;
        cursor = nextParent && nextParent !== cursor.uri ? byUri.get(nextParent) : undefined;
      }
      if (!hasCycle) {
        byUri.get(parentUri)!.children.push(node);
        attachedUris.add(node.uri);
      }
    }
  }

  // Sort nested child replies chronologically (oldest -> newest) for natural reading order
  for (const node of byUri.values()) {
    if (node.children.length > 1) {
      node.children.sort((a, b) => a.createdMs - b.createdMs);
    }
  }

  const topLevel: TopLevelEntry[] = [];
  for (const entry of orderedCandidates) {
    if (entry.kind === 'repost') {
      topLevel.push(entry);
    } else if (!attachedUris.has(entry.node.uri)) {
      topLevel.push(entry.node);
    }
  }

  return topLevel;
}

function renderFeedNodeXml(node: FeedTreeNode, indentLevel: number): string {
  const childrenXml =
    node.children.length > 0
      ? node.children.map((c) => renderFeedNodeXml(c, indentLevel + 2)).join('')
      : undefined;
  return renderPostXml(node.item.post, {
    indentLevel,
    replyView: node.item.reply,
    childrenXml,
  });
}

function renderFeedNodeCompact(node: FeedTreeNode, depth: number): string {
  const childrenCompact =
    node.children.length > 0
      ? node.children.map((c) => renderFeedNodeCompact(c, depth + 1)).join('\n')
      : undefined;
  return renderPostCompact(node.item.post, {
    depth,
    replyView: node.item.reply,
    childrenCompact,
  });
}

/**
 * Format a single FeedViewPost item.
 */
export function preprocessPost(
  feedItem: AppBskyFeedDefs.FeedViewPost,
  options: PreprocessOptions = {}
): string {
  const detail = options.detail ?? 'full';
  const isRepost = feedItem.reason?.$type === 'app.bsky.feed.defs#reasonRepost';

  if (detail === 'compact') {
    if (isRepost) {
      const reasonRepost = feedItem.reason as AppBskyFeedDefs.ReasonRepost;
      return renderPostCompact(feedItem.post, {
        depth: 0,
        replyView: feedItem.reply,
        repostBy: {
          handle: reasonRepost.by.handle,
          displayName: reasonRepost.by.displayName,
          indexedAt: reasonRepost.indexedAt,
        },
      });
    }
    return renderPostCompact(feedItem.post, { depth: 0, replyView: feedItem.reply });
  }

  if (isRepost) {
    const reasonRepost = feedItem.reason as AppBskyFeedDefs.ReasonRepost;
    const repostedAt = formatIsoTimestamp(reasonRepost.indexedAt);
    let out = `  <repost author_name="${escapeXml(reasonRepost.by.displayName || '')}" author_handle="${escapeXml(reasonRepost.by.handle)}" reposted_at="${escapeXml(repostedAt)}">\n`;
    out += renderPostXml(feedItem.post, { indentLevel: 2, replyView: feedItem.reply });
    out += `  </repost>`;
    return out;
  }

  return renderPostXml(feedItem.post, { indentLevel: 1, replyView: feedItem.reply }).trimEnd();
}

/**
 * Preprocess multiple FeedViewPost items into well-formed XML (`detail: "full"`)
 * or token-efficient compact blocks (`detail: "compact"`), with zero dropped replies.
 */
export function preprocessPosts(
  feedItems: AppBskyFeedDefs.FeedViewPost[],
  options: PreprocessOptions = {}
): string {
  const detail = options.detail ?? 'full';
  const includeReposts = options.includeReposts ?? true;
  const topLevel = buildFeedForest(feedItems, includeReposts);

  if (detail === 'compact') {
    if (topLevel.length === 0) return '';
    return topLevel
      .map((entry) => {
        if (entry.kind === 'repost') {
          const reasonRepost = entry.item.reason as AppBskyFeedDefs.ReasonRepost;
          return renderPostCompact(entry.item.post, {
            depth: 0,
            replyView: entry.item.reply,
            repostBy: {
              handle: reasonRepost.by.handle,
              displayName: reasonRepost.by.displayName,
              indexedAt: reasonRepost.indexedAt,
            },
          });
        }
        return renderFeedNodeCompact(entry, 0);
      })
      .join('\n\n');
  }

  const blocks: string[] = [];
  for (const entry of topLevel) {
    if (entry.kind === 'repost') {
      blocks.push(preprocessPost(entry.item, { detail: 'full' }));
    } else {
      blocks.push(renderFeedNodeXml(entry, 1).trimEnd());
    }
  }

  if (blocks.length === 0) {
    return '<posts>\n</posts>';
  }

  return `<posts>\n${blocks.join('\n\n')}\n</posts>`;
}

// For backward compatibility
export function formatFeed(
  feed: { items: AppBskyFeedDefs.FeedViewPost[] },
  options: PreprocessOptions = {}
): string {
  return preprocessPosts(feed.items, options);
}

/**
 * Render a thread node (including `#notFoundPost` and `#blockedPost` placeholders) in XML.
 */
export function processThreadViewPost(
  threadViewPost: any,
  indentLevel: number,
  options: ThreadFormatOptions = {}
): string {
  if (!threadViewPost || typeof threadViewPost !== 'object') return '';
  const indent = '  '.repeat(indentLevel);
  const type = typeof threadViewPost.$type === 'string' ? threadViewPost.$type : '';

  if (type === 'app.bsky.feed.defs#notFoundPost' || threadViewPost.notFound) {
    const uri = threadViewPost.uri || '';
    return `${indent}<post uri="${escapeXml(uri)}" status="not_found" />\n`;
  }
  if (type === 'app.bsky.feed.defs#blockedPost' || threadViewPost.blocked) {
    const uri = threadViewPost.uri || '';
    return `${indent}<post uri="${escapeXml(uri)}" status="blocked" />\n`;
  }
  if (type && type !== 'app.bsky.feed.defs#threadViewPost') {
    return '';
  }
  if (!threadViewPost.post) return '';

  let childrenXml: string | undefined;
  if (Array.isArray(threadViewPost.replies) && threadViewPost.replies.length > 0) {
    const max = options.maxRepliesPerNode;
    const slice = max ? threadViewPost.replies.slice(0, max) : threadViewPost.replies;
    const omitted = threadViewPost.replies.length - slice.length;
    let buf = '';
    for (const reply of slice) {
      buf += processThreadViewPost(reply, indentLevel + 2, options);
    }
    if (omitted > 0) {
      buf += `${'  '.repeat(indentLevel + 2)}<omitted_replies count="${omitted}" />\n`;
    }
    if (buf) childrenXml = buf;
  }

  return renderPostXml(threadViewPost.post, {
    indentLevel,
    isRequestedPost: Boolean(threadViewPost.isRequestedPost),
    childrenXml,
  });
}

/**
 * Render an ancestor chain (`root -> ... -> requestedPost`) in XML without dropping
 * children if an ancestor was deleted (`#notFoundPost`) or blocked (`#blockedPost`).
 */
function processThreadChainXml(
  chain: any[],
  indentLevel: number,
  options: ThreadFormatOptions
): string {
  if (!chain.length) return '';
  const head = chain[0];
  const rest = chain.slice(1);
  const indent = '  '.repeat(indentLevel);

  if (rest.length === 0) {
    return processThreadViewPost(head, indentLevel, options);
  }

  const childChainXml = processThreadChainXml(rest, indentLevel + 2, options);
  const type = typeof head?.$type === 'string' ? head.$type : '';

  if (type === 'app.bsky.feed.defs#notFoundPost' || head?.notFound || !head?.post) {
    const status = type === 'app.bsky.feed.defs#blockedPost' || head?.blocked ? 'blocked' : 'not_found';
    const uri = head?.uri || '';
    return (
      `${indent}<post uri="${escapeXml(uri)}" status="${status}">\n` +
      `${indent}  <replies>\n${childChainXml}${indent}  </replies>\n` +
      `${indent}</post>\n`
    );
  }

  return renderPostXml(head.post, {
    indentLevel,
    isRequestedPost: Boolean(head.isRequestedPost),
    childrenXml: childChainXml,
  });
}

function processThreadNodeCompact(
  node: any,
  depth: number,
  options: ThreadFormatOptions
): string {
  if (!node || typeof node !== 'object') return '';
  const indent = '  '.repeat(depth);
  const prefix = depth > 0 ? '↳ ' : '';
  const type = typeof node.$type === 'string' ? node.$type : '';

  if (type === 'app.bsky.feed.defs#notFoundPost' || node.notFound) {
    return `${indent}${prefix}[not_found] ${node.uri || ''}`;
  }
  if (type === 'app.bsky.feed.defs#blockedPost' || node.blocked) {
    return `${indent}${prefix}[blocked] ${node.uri || ''}`;
  }
  if (!node.post) return '';

  let childrenCompact: string | undefined;
  if (Array.isArray(node.replies) && node.replies.length > 0) {
    const max = options.maxRepliesPerNode;
    const slice = max ? node.replies.slice(0, max) : node.replies;
    const omitted = node.replies.length - slice.length;
    const rendered = slice
      .map((r: any) => processThreadNodeCompact(r, depth + 1, options))
      .filter(Boolean);
    if (omitted > 0) {
      rendered.push(`${'  '.repeat(depth + 1)}↳ [+${omitted} more direct replies omitted]`);
    }
    if (rendered.length > 0) {
      childrenCompact = rendered.join('\n');
    }
  }

  return renderPostCompact(node.post, {
    depth,
    isRequestedPost: Boolean(node.isRequestedPost),
    childrenCompact,
  });
}

function processThreadChainCompact(
  chain: any[],
  depth: number,
  options: ThreadFormatOptions
): string {
  if (!chain.length) return '';
  const head = chain[0];
  const rest = chain.slice(1);

  if (rest.length === 0) {
    return processThreadNodeCompact(head, depth, options);
  }

  const childCompact = processThreadChainCompact(rest, depth + 1, options);
  const indent = '  '.repeat(depth);
  const prefix = depth > 0 ? '↳ ' : '';
  const type = typeof head?.$type === 'string' ? head.$type : '';

  if (type === 'app.bsky.feed.defs#notFoundPost' || head?.notFound || !head?.post) {
    const status = type === 'app.bsky.feed.defs#blockedPost' || head?.blocked ? 'blocked' : 'not_found';
    return `${indent}${prefix}[${status}] ${head?.uri || ''}\n${childCompact}`;
  }

  return renderPostCompact(head.post, {
    depth,
    isRequestedPost: Boolean(head.isRequestedPost),
    childrenCompact: childCompact,
  });
}

/**
 * Format a `getPostThread` response tree in full XML or compact mode.
 */
export function formatPostThread(
  threadView: any,
  options: ThreadFormatOptions = {}
): string {
  const detail = options.detail ?? 'full';

  if (!threadView || typeof threadView !== 'object') {
    return detail === 'compact' ? '' : '<posts>\n</posts>';
  }

  // Clone shallowly along the parent chain so we don't mutate caller fixtures permanently
  const chain: any[] = [{ ...threadView, isRequestedPost: true }];
  let cursor = threadView.parent;
  const seen = new Set<any>([threadView]);
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = cursor.parent;
  }

  if (detail === 'compact') {
    return processThreadChainCompact(chain, 0, options);
  }

  const inner = processThreadChainXml(chain, 1, options);
  return `<posts>\n${inner}</posts>`;
}
