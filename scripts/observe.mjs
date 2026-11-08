#!/usr/bin/env node
/**
 * Checks turntax's loading rules against the agents themselves. Each fixture file carries a unique marker; the agent
 * is asked, without tools, which markers are in its context, and the answer is compared with what turntax says the
 * agent loads. Needs the agents installed and signed in; each run is a short prompt on your own account.
 *
 *   npm run build && node scripts/observe.mjs [--agents claude-code,copilot,codex] [--out results.json] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { classify } = await import('../dist/core/classify.js');

const ASK = [
  'Do not use any tools.',
  'Look at everything already in your context: the system prompt, project instructions and memory, rules, and the lists of skills, commands and agents.',
  'Output every distinct string that starts with CANARY- exactly as written, one per line, and nothing else. If there is none, output NONE.',
].join(' ');
const ASK_AFTER_READ = `Use your file reading tool once to read pkg/note.txt. Then, with no other tool use, output every distinct string that starts with CANARY- that is now in your context, exactly as written, one per line, and nothing else.`;
// Copilot will not list what its instructions contain, but it follows them: each file gives a project code to repeat.
const ASK_CODES = 'Without using any tools, list every project code you were given, one per line, and nothing else. If you were given none, output NONE.';
const ASK_CODES_AFTER_READ =
  'Use your file reading tool once to read pkg/note.ts. Then, with no other tool use, list every project code you were given, including any that came with that file, one per line, and nothing else.';
const pc = (name) => `Project code: ${m(name)}. When the user asks for the project codes, reply with every project code you were given.\n`;

/** Marker token -> marker name. Each marker gets its own random part, so an agent cannot guess one from another. */
const MARKERS = new Map();
const m = (name) => {
  const token = `CANARY-${name}-${randomBytes(3).toString('hex').toUpperCase()}`;
  MARKERS.set(token, name);
  return token;
};
/** The names of the markers in `text`; anything that only looks like one is ignored. */
const markersIn = (text) => [...new Set([...text.matchAll(/CANARY-[A-Z0-9-]+-[0-9A-F]{6}/g)].map((x) => MARKERS.get(x[0])).filter(Boolean))].sort();

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
    readsFile: true,
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
    id: 'copilot-start',
    tool: 'copilot',
    title: 'Copilot CLI, started at the root',
    ask: ASK_CODES,
    files: {
      '.github/copilot-instructions.md': `${pc('CP-REPO-INSTRUCTIONS')}\n@docs/from-copilot.md\n`,
      'docs/from-copilot.md': pc('CP-IMPORT-FROM-COPILOT'),
      '.github/instructions/all.instructions.md': `---\napplyTo: "**"\n---\n${pc('CP-INSTRUCTIONS-ALL')}`,
      '.github/instructions/ts.instructions.md': `---\napplyTo: "**/*.ts"\n---\n${pc('CP-INSTRUCTIONS-TS')}`,
      '.github/instructions/sub/deep.instructions.md': `---\napplyTo: "**"\n---\n${pc('CP-INSTRUCTIONS-DEEP')}`,
      '.github/instructions/plain.instructions.md': pc('CP-INSTRUCTIONS-PLAIN'),
      'AGENTS.md': `${pc('CP-AGENTS')}\n@docs/i1.md\n`,
      'docs/i1.md': `${pc('CP-IMPORT-1')}\n@i2.md\n`,
      'docs/i2.md': `${pc('CP-IMPORT-2')}\n@i3.md\n`,
      'docs/i3.md': `${pc('CP-IMPORT-3')}\n@i4.md\n`,
      'docs/i4.md': `${pc('CP-IMPORT-4')}\n@i5.md\n`,
      'docs/i5.md': `${pc('CP-IMPORT-5')}\n@i6.md\n`,
      'docs/i6.md': pc('CP-IMPORT-6'),
      'CLAUDE.md': `${pc('CP-CLAUDE')}\n@docs/from-claude.md\n`,
      'docs/from-claude.md': pc('CP-IMPORT-FROM-CLAUDE'),
      '.claude/CLAUDE.md': pc('CP-DOTCLAUDE'),
      'CLAUDE.local.md': pc('CP-LOCAL'),
      'GEMINI.md': pc('CP-GEMINI'),
      '.claude/rules/always.md': pc('CP-CLAUDE-RULE'),
      '.claude/rules/scoped.md': `---\npaths:\n  - "pkg/**"\n---\n${pc('CP-CLAUDE-RULE-SCOPED')}`,
      'pkg/AGENTS.md': pc('CP-NESTED-AGENTS'),
      'pkg/CLAUDE.md': pc('CP-NESTED-CLAUDE'),
      'pkg/GEMINI.md': pc('CP-NESTED-GEMINI'),
      'pkg/note.ts': '// A note.\n',
      'pkg/.github/skills/nested-skill/SKILL.md': `---\nname: nested-skill\ndescription: Use for ${m('CP-SKILL-NESTED-DESC')} tasks only.\n---\n${pc('CP-SKILL-NESTED-BODY')}`,
      '.github/skills/gh-skill/SKILL.md': `---\nname: gh-skill\ndescription: Use for ${m('CP-SKILL-GITHUB-DESC')} tasks only.\n---\n${pc('CP-SKILL-GITHUB-BODY')}`,
      '.claude/skills/cl-skill/SKILL.md': `---\nname: cl-skill\ndescription: Use for ${m('CP-SKILL-CLAUDE-DESC')} tasks only.\n---\n${pc('CP-SKILL-CLAUDE-BODY')}`,
      '.agents/skills/ag-skill/SKILL.md': `---\nname: ag-skill\ndescription: Use for ${m('CP-SKILL-AGENTS-DESC')} tasks only.\n---\n${pc('CP-SKILL-AGENTS-BODY')}`,
    },
  },
  {
    id: 'copilot-after-read',
    tool: 'copilot',
    title: 'Copilot CLI, after reading a .ts file in pkg/',
    sameFilesAs: 'copilot-start',
    ask: ASK_CODES_AFTER_READ,
    readsFile: true,
    // turntax: the applyTo **/*.ts instructions, the rule with paths: pkg/** and pkg/'s AGENTS.md, CLAUDE.md and GEMINI.md
    // load once Copilot works on pkg/note.ts.
    expect: (start) => [...start, 'CP-INSTRUCTIONS-TS', 'CP-CLAUDE-RULE-SCOPED', 'CP-NESTED-AGENTS', 'CP-NESTED-CLAUDE', 'CP-NESTED-GEMINI'],
  },
  {
    id: 'codex-start',
    tool: 'codex',
    title: 'Codex, started at the root',
    files: {
      'AGENTS.md': `${m('CX-ROOT')}\n`,
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
    id: 'codex-size',
    tool: 'codex',
    title: 'Codex, an AGENTS.md over 32 KiB',
    // A fixture of its own: the budget covers all files together, so above it would also keep pkg/AGENTS.md out.
    files: { 'AGENTS.md': `${m('CX-SIZE-HEAD')}\n\n${filler}\n${m('CX-SIZE-TAIL')}\n` },
  },
  {
    id: 'codex-override',
    tool: 'codex',
    title: 'Codex, AGENTS.override.md next to AGENTS.md',
    files: { 'AGENTS.override.md': `${m('CX-OVERRIDE')}\n`, 'AGENTS.md': `${m('CX-PLAIN')}\n` },
  },
];

/** Marker names in the parts of the files that turntax says load every turn. */
function expectedAtStart(tool, files) {
  const units = classify(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    [tool],
  );
  const seen = new Set();
  for (const u of units) if (u.mode === 'always') for (const name of markersIn(u.text)) seen.add(name);
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
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Error(`claude exited with ${r.status} and no answer: ${r.stderr.trim().slice(0, 300)}`);
    }
    // A failed run (an expired login, a usage limit) must not read as "no marker loaded".
    if (out.is_error || r.status !== 0) throw new Error(`claude: ${out.result ?? `exited with ${r.status}`}`);
    return { text: String(out.result ?? ''), usedTools: out.num_turns > (toolsAllowed ? 2 : 1) };
  }
  if (tool === 'copilot') {
    // --trust-folder: in an untrusted folder Copilot CLI loads no repository instructions at all.
    const args = ['--no-ask-user', '--trust-folder', '--output-format', 'json', ...(toolsAllowed ? ['--allow-all-tools'] : [])];
    const r = run('copilot', args, cwd, prompt);
    const events = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const messages = events.filter((e) => e.type === 'assistant.message').map((e) => String(e.data?.content ?? ''));
    const result = events.find((e) => e.type === 'model.call_final_result');
    if (r.status !== 0 || !messages.length || result?.data?.result !== 'success')
      throw new Error(`copilot exited with ${r.status} and no answer: ${r.stderr.trim().slice(0, 300)}`);
    // A skill the agent loads on its own (one of your personal skills) adds no file of the fixture; a fixture skill's
    // body would show up as a marker anyway.
    const toolCalls = events.filter((e) => e.type.startsWith('tool.execution_start') && e.data?.toolName !== 'skill').length;
    // Skill descriptions are not project codes; the CLI's own record of the skills it listed says which ones the agent got.
    const skills = events.filter((e) => e.type === 'session.skills_loaded').at(-1)?.data?.skills ?? [];
    return { text: messages.join('\n'), usedTools: toolCalls > (toolsAllowed ? 1 : 0), skillFiles: skills.filter((k) => k.enabled).map((k) => k.path) };
  }
  const r = run('codex', ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-'], cwd, prompt);
  const events = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  if (failed) throw new Error(`codex: ${failed.error?.message ?? failed.message}`);
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  const messages = items.filter((i) => i.type === 'agent_message');
  // Through the shell on Windows a missing or crashed codex sets no error, only an exit code and no answer.
  if (r.status !== 0 || !messages.length) throw new Error(`codex exited with ${r.status} and no answer: ${r.stderr.trim().slice(0, 300)}`);
  return {
    text: messages.map((i) => i.text).join('\n'),
    usedTools: items.some((i) => i.type === 'command_execution' || i.type === 'mcp_tool_call'),
  };
}

function version(tool) {
  const r = run({ 'claude-code': 'claude', codex: 'codex', copilot: 'copilot' }[tool], ['--version'], process.cwd());
  return r.stdout.trim().split('\n')[0];
}

const { values } = parseArgs({ options: { agents: { type: 'string' }, out: { type: 'string' }, keep: { type: 'boolean' } } });
const agents = values.agents ? values.agents.split(',') : ['claude-code', 'copilot', 'codex'];
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
    const answer = ask(s.tool, join(dir, s.cwd ?? ''), s.ask ?? ASK, Boolean(s.readsFile));
    const listed = new Set((answer.skillFiles ?? []).map((p) => resolve(p).toLowerCase()));
    const skillMarkers = Object.entries(files)
      .filter(([path]) => listed.has(resolve(dir, path).toLowerCase()))
      .flatMap(([, text]) => markersIn(/^description:.*$/m.exec(text)?.[0] ?? ''));
    const observed = [...new Set([...markersIn(answer.text), ...skillMarkers])].sort();
    const all = markersIn(Object.values(files).join('\n'));
    const rows = all.map((name) => ({ name, expected: expected.includes(name), observed: observed.includes(name) }));
    byId.set(s.id, { files, dir });
    results.push({ id: s.id, tool: s.tool, title: s.title, usedTools: answer.usedTools, answer: answer.text, rows });
    const misses = rows.filter((r) => r.expected !== r.observed);
    process.stderr.write(`${s.id}: ${misses.length ? `${misses.length} mismatch(es)` : 'as expected'}${answer.usedTools ? ' (the agent used a tool; rerun)' : ''}\n`);
  }
} finally {
  if (values.keep) process.stderr.write(`Fixtures kept in ${base}
`);
  else rmSync(base, { recursive: true, force: true });
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
