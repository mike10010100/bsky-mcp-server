import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * A prompt that instructs the LLM to fetch the Bluesky timeline and create a summary of posts.
 */
const TIMELINE_SUMMARY_PROMPT = `
I need you to get my Bluesky timeline and provide a summary of what people are talking about.

Please follow these steps:
1. Use the "get-timeline" tool to fetch my most recent posts (limit: 50)
2. Analyze the posts and identify common themes, topics, and discussions
3. Create a concise summary of the main conversations happening
4. Highlight any trending hashtags or notable discussions
5. Note any significant announcements or news being shared
6. Organize your summary into clear sections

For your summary, please include:
- Main topics/themes being discussed
- Any trending hashtags
- Notable conversations or threads
- Overall sentiment/mood of the timeline
- Any breaking news or important announcements

Please keep the summary concise (about 3-5 paragraphs) and focus on the most meaningful content rather than just listing all posts.
`;

/**
 * Registers all Bluesky MCP prompts on the provided MCP server
 * @param server The MCP server instance
 */
export function registerPrompts(server: McpServer | any): void {
  const handler = () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: TIMELINE_SUMMARY_PROMPT
      }
    }]
  });

  if (typeof server.registerPrompt === 'function') {
    server.registerPrompt(
      "summarize-timeline",
      {
        title: "Summarize Timeline",
        description: "A prompt that instructs the LLM to fetch the Bluesky timeline and create a summary of posts.",
        argsSchema: z.object({})
      },
      handler
    );
  } else if (typeof server.prompt === 'function') {
    server.prompt(
      "summarize-timeline",
      {},
      handler
    );
  }
}
 