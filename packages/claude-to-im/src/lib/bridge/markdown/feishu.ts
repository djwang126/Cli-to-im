import type { ToolCallInfo } from '../types.js';
import { FEISHU_STREAMING_ELEMENT_ID } from '../adapters/feishu-cardkit.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

type FeishuCardElement = Record<string, unknown>;
export const FEISHU_TOOLS_MARKER = 'using tools...';
export interface FeishuFinalCardEntry {
  kind: 'text' | 'tools';
  content: string;
}

function buildSchema2Card(params: {
  header?: Record<string, unknown>;
  config?: Record<string, unknown>;
  elements: FeishuCardElement[];
}): string {
  const payload: Record<string, unknown> = {
    schema: '2.0',
    body: {
      elements: params.elements,
    },
  };

  if (params.header) payload.header = params.header;
  if (params.config) payload.config = params.config;

  return JSON.stringify(payload);
}

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return buildSchema2Card({
    config: {
      wide_screen_mode: true,
    },
    elements: [{
      tag: 'markdown',
      content: text,
    }],
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Collapse any active tool snapshot to a single sentence.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  return tools.length > 0 ? FEISHU_TOOLS_MARKER : '';
}

export function buildChronologicalMarkdown(entries: FeishuFinalCardEntry[]): string {
  const parts = entries
    .map((entry) => ({
      kind: entry.kind,
      content: entry.kind === 'text'
        ? preprocessFeishuMarkdown(entry.content)
        : entry.content.trim(),
    }))
    .filter((entry) => entry.kind === 'text' ? entry.content.length > 0 : entry.content.length > 0);

  if (parts.length === 0) return '';
  return parts.map((entry) => entry.content).join('\n\n');
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

/**
 * Build the body content for a streaming card update using the same rule as the final card.
 */
export function buildStreamingContent(
  entries: FeishuFinalCardEntry[],
  fallbackText = '',
  tools: ToolCallInfo[] = [],
): string {
  const content = buildChronologicalMarkdown(entries);
  if (content) return content;

  const text = preprocessFeishuMarkdown(fallbackText);
  if (text) return text;

  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) return toolMd;

  return ' ';
}

/**
 * Build the initial streaming card JSON.
 * CardKit v1 creates a card entity that still uses schema 2.0 content.
 */
export function buildStreamingCardJson(initialText = '💭 Thinking...'): string {
  return buildSchema2Card({
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      summary: { content: '生成中...' },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: 'fast',
      },
    },
    elements: [{
      tag: 'markdown',
      content: initialText,
      text_align: 'left',
      text_size: 'normal',
      element_id: FEISHU_STREAMING_ELEMENT_ID,
    }],
  });
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
  entries: FeishuFinalCardEntry[] = [],
): string {
  const elements: Array<Record<string, unknown>> = [];
  const chronologicalContent = buildChronologicalMarkdown(entries);
  let content = chronologicalContent || preprocessFeishuMarkdown(text);

  if (!chronologicalContent) {
    const toolMd = buildToolProgressMarkdown(tools);
    if (toolMd) {
      content = content ? `${content}\n\n${toolMd}` : toolMd;
    }
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return buildSchema2Card({
    config: { wide_screen_mode: true },
    elements,
  });
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
  callbackNamespace: 'perm' | 'diag' = 'perm',
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonRows = buttons.map((btn) => ({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_align: 'left',
    columns: [{
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: btn.label },
        type: btn.type,
        size: 'medium',
        value: {
          callback_data: `${callbackNamespace}:${btn.action}:${permissionRequestId}`,
          ...(chatId ? { chatId } : {}),
        },
      }],
    }],
  }));

  return buildSchema2Card({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    elements: [
      { tag: 'markdown', content: text, text_size: 'normal' },
      { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
      { tag: 'hr' },
      ...buttonRows,
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: callbackNamespace === 'perm'
          ? 'Or reply: `1` Allow · `2` Allow Session · `3` Deny'
          : 'Diagnostic card: tap any button to verify callbacks and toast handling',
        text_size: 'notation',
      },
    ],
  });
}
