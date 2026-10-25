import { parentPort, workerData } from 'node:worker_threads';
import { planWorkspaceFixes } from '../../src/node/workspace.js';
import { auditFolder } from './engine.js';

/**
 * One audit or fix plan, off the extension host's thread: walking a large folder takes seconds to minutes
 * and would freeze every other extension, and only this thread loads the engine and its tokenizer. The
 * extension starts one worker per job and gets plain data back.
 */
const { kind, root } = workerData as { kind: 'audit' | 'plan'; root: string };
(kind === 'audit' ? auditFolder(root) : planWorkspaceFixes(root)).then(
  (result) => parentPort!.postMessage({ result }),
  (e: unknown) => parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) }),
);
