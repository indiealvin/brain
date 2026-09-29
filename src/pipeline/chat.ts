/**
 * The conversational reply (design §3, §4, §17): one model call over the
 * session transcript plus a few retrieved notes. Knowledge maintenance is a
 * separate, later step (`processTurnForKnowledge`) and never blocks this.
 *
 * `CHAT_SYSTEM_PROMPT` is a stable constant so the provider can cache it;
 * retrieved excerpts are appended *after* it in the system prompt.
 */
import type { ConversationTurn, EmbeddingProvider, ModelProvider } from "../core/types";
import type { IndexDb } from "../index/schema";
import { hybridSearch } from "../retrieval/hybrid";

export const CHAT_SYSTEM_PROMPT = `You are the user's thinking partner over their personal knowledge base: a set of Markdown notes that capture their ideas, decisions, hypotheses, questions, observations and references.

Continue the discussion naturally, as a curious and well-read collaborator would. Build on what the user says, ask a sharp question when it helps, offer a relevant connection or counterpoint, and be concise. Match the user's register; do not lecture.

When notes from the knowledge base are relevant, use them and cite them by title (for example: "In *Reversibility enables agent autonomy* you argued ..."). Do not claim a note says something it does not. If no note is relevant, simply do not mention the knowledge base.

Knowledge maintenance is not your job and happens automatically after each turn. Never tell the user to "save", "note down", "record", "add a note" or "remember" anything, never announce that something was or will be saved, and never ask whether something should be stored.`;

export interface ContextNote {
  title: string;
  path: string;
  excerpt: string;
}

export const DEFAULT_CONTEXT_LIMIT = 5;
export const EXCERPT_CHARS = 600;
export const DEFAULT_CHAT_MAX_TOKENS = 2048;

/** A ~`max`-char excerpt of a note body: title line dropped, whitespace collapsed, cut on a word boundary. */
export function excerptOf(body: string, max = EXCERPT_CHARS): string {
  const text = body
    .replace(/^#\s+.*$/m, "")
    .replace(/\r?\n\s*\r?\n/g, " ¶ ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${text.slice(0, cut > max / 2 ? cut : max).trimEnd()} …`;
}

/** Retrieve up to `limit` notes for `userText` and read title/path/excerpt from the index. */
export async function retrieveContext(db: IndexDb, embeddings: EmbeddingProvider, userText: string, limit = DEFAULT_CONTEXT_LIMIT): Promise<ContextNote[]> {
  if (userText.trim() === "" || limit <= 0) return [];
  const hits = await hybridSearch(db, embeddings, userText, { limit });
  const out: ContextNote[] = [];
  for (const hit of hits) {
    const row = db
      .query("SELECT n.title AS title, n.path AS path, f.body AS body FROM notes n LEFT JOIN notes_fts f ON f.note_id = n.note_id WHERE n.note_id = ?")
      .get(hit.noteId) as { title: string; path: string; body: string | null } | null;
    if (!row) continue;
    out.push({ title: row.title, path: row.path, excerpt: excerptOf(row.body ?? "") });
  }
  return out;
}

export interface ChatMessages {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

function renderContext(notes: ContextNote[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => `### ${n.title}\n(${n.path})\n${n.excerpt}`);
  return `\n\n## Possibly relevant notes from the knowledge base\n\n${lines.join("\n\n")}`;
}

/**
 * System prompt = stable prefix + retrieved context; messages = the turns
 * mapped 1:1 to chat roles. Consecutive same-role turns are merged so the
 * result always alternates and starts with a user message.
 */
export function buildChatMessages(turns: ConversationTurn[], contextNotes: ContextNote[]): ChatMessages {
  const messages: ChatMessages["messages"] = [];
  for (const t of turns) {
    const text = t.text.trim();
    if (text === "") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${text}`;
    else if (messages.length === 0 && t.role === "assistant") messages.push({ role: "user", content: "(conversation resumed)" }, { role: "assistant", content: text });
    else messages.push({ role: t.role, content: text });
  }
  return { system: CHAT_SYSTEM_PROMPT + renderContext(contextNotes), messages };
}

export interface ReplyDeps {
  db: IndexDb;
  model: ModelProvider;
  embeddings: EmbeddingProvider;
}

export interface ReplyOptions {
  contextLimit?: number;
  maxTokens?: number;
}

/** One `model.complete` call: retrieve context for the latest user turn, then reply. */
export async function replyToTurn(deps: ReplyDeps, turns: ConversationTurn[], opts: ReplyOptions = {}): Promise<{ reply: string; contextNotes: ContextNote[] }> {
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const contextNotes = lastUser ? await retrieveContext(deps.db, deps.embeddings, lastUser.text, opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT) : [];
  const { system, messages } = buildChatMessages(turns, contextNotes);
  if (messages.length === 0) messages.push({ role: "user", content: "(empty turn)" });
  const reply = await deps.model.complete({ system, messages, maxTokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS });
  return { reply: reply.trim(), contextNotes };
}
