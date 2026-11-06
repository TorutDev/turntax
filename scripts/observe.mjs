#!/usr/bin/env node
/**
 * Checks turntax's loading rules against the agents themselves. Each fixture file carries a unique marker; the agent
 * is asked, without tools, which markers are in its context, and the answer is compared with what turntax says the
 * agent loads. Needs the agents installed and signed in; each run is a short prompt on your own account.
 *
 *   npm run build && node scripts/observe.mjs [--agents claude-code,codex] [--out results.json]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { classify } = await import('../dist/core/classify.js');

const ASK = [
  'Do not use any tools.',
  'Look at everything already in your context: the system prompt, project instructions and memory, rules, and the lists of skills, commands and agents.',
  'Output every distinct string that starts with CANARY- exactly as written, one per line, and nothing else. If there is none, output NONE.',
].join(' ');
const ASK_AFTER_READ = `Use your file reading tool once to read pkg/note.txt. Then, with no other tool use, output every distinct string that starts with CANARY- that is now in your context, exactly as written, one per line, and nothing else.`;

const tag = randomBytes(2).toString('hex').toUpperCase();
const m = (name) => `CANARY-${name}-${tag}`;

/** Codex reads at most 32 KiB of AGENTS.md; the tail marker sits past it. */
const filler = Array.from({ length: 1400 }, (_, i) => `Filler line ${i} for the size test; ignore it.`).join('\n');

/** A fixture: files, the agent, the folder to start in, the prompt, and (for follow-ups) the markers turntax expects. */
const SCENARIOS = [
  {
    id: 'claude-start',
    tool: 'claude-code',
    title: 'Claude Code, started at the root',
    files: {
      'CLAUDE.md': `# Project\n\nMarker ${m('CC-ROOT')}.\n\n<!-- ${m('CC-COMMENT')} -->\n\n@docs/i1.md\n`,
      'docs/i1.md': `${m('CC-IMPORT-1')}\n@i2.md\n`,
      'docs/i2.md': `${m('CC-IMPORT-2')}\n@i3.md\n`,
      'docs/i3.md': `${m('CC-IMPORT-3')}\n@i4.md\n`,
      'docs/i4.md': `${m('CC-IMPORT-4')}\n@i5.md\n`,
      'docs/i5.md': `${m('CC-IMPORT-5')}\n@i6.md\n`,
      'docs/i6.md': `${m('CC-IMPORT-6')}\n`,
      'CLAUDE.local.md': `${m('CC-LOCAL')}\n`,
      '.claude/CLAUDE.md': `${m('CC-DOTCLAUDE')}\n`,
      'AGENTS.md': `${m('CC-AGENTS')}\n`,
      'pkg/CLAUDE.md': `${m('CC-NESTED')}\n`,
      'pkg/note.txt': 'A note.\n',
      '.claude/rules/always.md': `${m('CC-RULE-ALWAYS')}\n`,
      '.claude/rules/scoped.md': `---\npaths:\n  - "pkg/**"\n---\n${m('CC-RULE-SCOPED')}\n`,
      '.claude/skills/canary-skill/SKILL.md': `---\nname: canary-skill\ndescription: Use for ${m('CC-SKILL-DESC')} tasks only.\n---\n${m('CC-SKILL-BODY')}\n`,
      '.claude/commands/canary-cmd.md': `---\ndescription: Command for ${m('CC-CMD-DESC')} only.\n---\n${m('CC-CMD-BODY')}\n`,
      '.claude/agents/canary-agent.md': `---\nname: canary-agent\ndescription: Agent for ${m('CC-AGENT-DESC')} only.\n---\n${m('CC-AGENT-BODY')}\n`,
    },
  },
  {
    id: 'claude-after-read',
    tool: 'claude-code',
    title: 'Claude Code, after reading a file in pkg/',
    sameFilesAs: 'claude-start',
    ask: ASK_AFTER_READ,
    // turntax: pkg/CLAUDE.md and a rule with paths: pkg/** load once Claude reads a file there.
    expect: (start) => [...start, 'CC-NESTED', 'CC-RULE-SCOPED'],
  },
  {
    id: 'claude-agents-only',
    tool: 'claude-code',
    title: 'Claude Code, AGENTS.md and no CLAUDE.md',
    files: { 'AGENTS.md': `${m('CC-AGENTS-ONLY')}\n` },
  },
  {
    id: 'codex-start',
    tool: 'codex',
    title: 'Codex, started at the root',
    files: {
      'AGENTS.md': `${m('CX-ROOT-HEAD')}\n\n${filler}\n${m('CX-ROOT-TAIL')}\n`,
      'pkg/AGENTS.md': `${m('CX-NESTED')}\n`,
      'pkg/note.txt': 'A note.\n',
      'CLAUDE.md': `${m('CX-CLAUDE')}\n`,
      '.agents/skills/canary-skill/SKILL.md': `---\nname: canary-skill\ndescription: Use for ${m('CX-SKILL-DESC')} tasks only.\n---\n${m('CX-SKILL-BODY')}\n`,
    },
  },
  {
    id: 'codex-in-pkg',
    tool: 'codex',
    title: 'Codex, started in pkg/',
    sameFilesAs: 'codex-start',
    cwd: 'pkg',
    // turntax: a nested AGENTS.md loads only when Codex is launched in that folder.
    expect: (start) => [...start, 'CX-NESTED'],
  },
  {
    id: 'codex-override',
    tool: 'codex',
    title: 'Codex, AGENTS.override.md next to AGENTS.md',
    files: { 'AGENTS.override.md': `${m('CX-OVERRIDE')}\n`, 'AGENTS.md': `${m('CX-PLAIN')}\n` },
  },
];

/** Marker names (without the run tag) in the parts of the files that turntax says load every turn. */
function expectedAtStart(tool, files) {
  const units = classify(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    [tool],
  );
  const seen = new Set();
  for (const u of units)
    if (u.mode === 'always') for (const x of u.text.matchAll(/CANARY-([A-Z0-9-]+)-[0-9A-F]{4}/g)) seen.add(x[1]);
  return [...seen].sort();
}

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  if (r.error) throw r.error;
  return r;
}

/** The answer text and whether the agent used a tool it was told not to. */
function ask(tool, cwd, prompt, toolsAllowed) {
  if (tool === 'claude-code') {
    // Default settings: AGENTS.md is read by a built-in plugin that --setting-sources without "user" turns off.
    const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
    const r = run('claude', args, cwd, prompt);
    const out = JSON.parse(r.stdout);
    // A failed run (an expired login, a usage limit) must not read as "no marker loaded".
    if (out.is_error) throw new Error(`claude: ${out.result}`);
    return { text: String(out.result ?? ''), usedTools: out.num_turns > (toolsAllowed ? 2 : 1) };
  }
  const r = run('codex', ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-'], cwd, prompt);
  const events = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  if (failed) throw new Error(`codex: ${failed.error?.message ?? failed.message}`);
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  return {
    text: items.filter((i) => i.type === 'agent_message').map((i) => i.text).join('\n'),
    usedTools: items.some((i) => i.type === 'command_execution' || i.type === 'mcp_tool_call'),
  };
}

function version(tool) {
  const r = run(tool === 'claude-code' ? 'claude' : 'codex', ['--version'], process.cwd());
  return r.stdout.trim().split('\n')[0];
}

const { values } = parseArgs({ options: { agents: { type: 'string' }, out: { type: 'string' } } });
const agents = values.agents ? values.agents.split(',') : ['claude-code', 'codex'];
const base = mkdtempSync(join(tmpdir(), 'turntax-observe-'));
const results = [];
const byId = new Map();
try {
  for (const s of SCENARIOS.filter((x) => agents.includes(x.tool))) {
    const source = s.sameFilesAs ? byId.get(s.sameFilesAs) : undefined;
    const files = source ? source.files : s.files;
    const dir = source ? source.dir : join(base, s.id);
    if (!source) write(dir, files);
    const start = expectedAtStart(s.tool, files);
    const expected = s.expect ? s.expect(start).sort() : start;
    const answer = ask(s.tool, join(dir, s.cwd ?? ''), s.ask ?? ASK, Boolean(s.ask));
    const observed = [...new Set([...answer.text.matchAll(new RegExp(`CANARY-([A-Z0-9-]+)-${tag}`, 'g'))].map((x) => x[1]))].sort();
    const all = [...new Set([...Object.values(files).join('\n').matchAll(/CANARY-([A-Z0-9-]+)-[0-9A-F]{4}/g)].map((x) => x[1]))].sort();
    const rows = all.map((name) => ({ name, expected: expected.includes(name), observed: observed.includes(name) }));
    byId.set(s.id, { files, dir });
    results.push({ id: s.id, tool: s.tool, title: s.title, usedTools: answer.usedTools, rows });
    const misses = rows.filter((r) => r.expected !== r.observed);
    process.stderr.write(`${s.id}: ${misses.length ? `${misses.length} mismatch(es)` : 'as expected'}${answer.usedTools ? ' (the agent used a tool; rerun)' : ''}\n`);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

const report = {
  date: new Date().toISOString().slice(0, 10),
  versions: Object.fromEntries(agents.map((a) => [a, version(a)])),
  results,
};
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
for (const r of results) {
  process.stdout.write(`\n### ${r.title}\n\n| Marker | turntax | Agent |\n| --- | --- | --- |\n`);
  for (const row of r.rows) process.stdout.write(`| ${row.name} | ${row.expected ? 'loaded' : '-'} | ${row.observed ? 'loaded' : '-'}${row.expected === row.observed ? '' : ' **differs**'} |\n`);
}
