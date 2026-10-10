export type ToolId = 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'copilot' | 'windsurf';

/** A file as seen by the audit: repo-relative POSIX path plus its text. */
export interface RepoFile {
  path: string;
  text: string;
}

/**
 * always    - sent with every turn of every session
 * on-demand - loaded only when the agent works in a directory, touches a matching file, or decides it is relevant
 * manual    - loaded only when the user explicitly references it
 * ignored   - the tool does not read this file in this situation
 */
export type LoadMode = 'always' | 'on-demand' | 'manual' | 'ignored';

/** Which part of a file a unit represents. Skills and description-driven rules split into two units. */
export type UnitPart = 'full' | 'description' | 'body';

export interface LoadedUnit {
  tool: ToolId;
  path: string;
  part: UnitPart;
  mode: LoadMode;
  /** Human-readable reason for the mode, e.g. "project root" or "applyTo: src/**". */
  trigger: string;
  /** The text the tool injects (after tool-specific transforms such as comment stripping or truncation). */
  text: string;
  /** Set when this unit was pulled in through an @import. */
  importedFrom?: string;
  notes: string[];
  /** Set when the file looks misconfigured for this tool (for example ignored because of its extension). */
  problem?: string;
}

export type CountMethod = 'offline-exact' | 'offline-proxy' | 'api' | 'unavailable';

export interface ModelInfo {
  id: string;
  label: string;
  family: 'claude' | 'openai' | 'gemini' | 'open';
  /** USD per 1M input tokens, or null when there is no public per-token price (self-hosted open models). */
  inputPerMTok: number | null;
  /** USD per 1M cache-read (cached input) tokens. */
  cachedInputPerMTok: number | null;
  priceNote?: string;
  source: string;
  checkedAt: string;
  /** How tokens are counted for this model without network access. */
  offline: 'o200k-exact' | 'o200k-proxy' | 'none';
  /** Model id sent to the vendor count endpoint, when counting via API. */
  apiModel?: string;
}

export interface TokenCount {
  tokens: number | null;
  method: CountMethod;
  reason?: string;
}

export interface Counter {
  /** Counts tokens for each text; must return results in the same order. */
  count(model: ModelInfo, texts: string[]): Promise<TokenCount[]>;
}
