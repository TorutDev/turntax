import type { Frontmatter } from './tools.js';

export interface ParsedDoc {
  frontmatter: Frontmatter;
  /** Text after the frontmatter block. */
  body: string;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parses a minimal YAML frontmatter block: scalars, inline [lists], and "- item" lists. */
export function parseFrontmatter(text: string): ParsedDoc {
  const match = FM_RE.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter: Frontmatter = {};
  let listKey: string | null = null;
  for (const raw of (match[1] ?? '').split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw) ?? /^-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const prev = frontmatter[listKey];
      const list = Array.isArray(prev) ? prev : [];
      list.push(unquote(item[1] ?? ''));
      frontmatter[listKey] = list;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1] as string;
    const value = (kv[2] ?? '').trim();
    listKey = null;
    if (value === '') {
      listKey = key;
      frontmatter[key] = '';
    } else if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      frontmatter[key] = value === 'true';
    } else {
      frontmatter[key] = unquote(value);
    }
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Splits text into lines, tagging lines that sit inside fenced code blocks. */
export function linesWithFences(text: string): Array<{ line: string; inFence: boolean }> {
  const out: Array<{ line: string; inFence: boolean }> = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const marker = (m[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) {
        out.push({ line, inFence: true });
        fence = null;
        continue;
      }
    }
    out.push({ line, inFence: fence !== null });
  }
  return out;
}

/** Removes block-level HTML comments outside fenced code, as Claude Code does for CLAUDE.md. */
export function stripHtmlComments(text: string): string {
  const kept: string[] = [];
  let inComment = false;
  for (const { line, inFence } of linesWithFences(text)) {
    if (inFence && !inComment) {
      kept.push(line);
      continue;
    }
    if (!inComment && /^\s*<!--/.test(line)) {
      if (line.includes('-->')) {
        const rest = line.slice(line.indexOf('-->') + 3);
        if (rest.trim()) kept.push(rest);
        continue;
      }
      inComment = true;
      continue;
    }
    if (inComment) {
      if (line.includes('-->')) {
        inComment = false;
        const rest = line.slice(line.indexOf('-->') + 3);
        if (rest.trim()) kept.push(rest);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Finds `@path` imports outside code spans and fenced blocks. */
export function findImports(text: string): string[] {
  const found: string[] = [];
  for (const { line, inFence } of linesWithFences(text)) {
    if (inFence) continue;
    const noCode = line.replace(/`[^`]*`/g, '');
    for (const m of noCode.matchAll(/(?:^|\s)@((?:~|\.{1,2})?\/?[\w.-][\w./-]*)/g)) {
      const target = (m[1] as string).replace(/[.,;:)]+$/, '');
      if (target.includes('/') || /\.\w+$/.test(target)) found.push(target);
    }
  }
  return found;
}

export interface Section {
  heading: string;
  /** 1-based line number of the heading (or 1 for the preamble). */
  line: number;
  text: string;
}

/** Splits markdown into sections at ATX headings of level 1-3 (outside fences). */
export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: '(top)', line: 1, text: '' };
  const lines = linesWithFences(text);
  lines.forEach(({ line, inFence }, i) => {
    const h = inFence ? null : /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (current.text.trim()) sections.push(current);
      current = { heading: h[2] as string, line: i + 1, text: line + '\n' };
    } else {
      current.text += line + '\n';
    }
  });
  if (current.text.trim()) sections.push(current);
  return sections;
}

/** First non-empty paragraph of a markdown body, ignoring headings. */
export function firstParagraph(body: string): string {
  const paras = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#/.test(p));
  return paras[0] ?? '';
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Resolves a relative import against the importing file's directory. Returns null when it escapes the repo. */
export function resolvePath(fromFile: string, target: string): string | null {
  // Home-relative and absolute paths point outside the repository.
  if (target.startsWith('~') || target.startsWith('/') || /^[A-Za-z]:/.test(target)) return null;
  const parts = dirname(fromFile).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
