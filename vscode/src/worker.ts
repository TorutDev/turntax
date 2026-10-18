import { parentPort, workerData } from 'node:worker_threads';
import { auditWorkspace, planWorkspaceFixes } from '../../src/node/workspace.js';

/**
 * One audit or fix plan, off the extension host's thread: walking a large folder takes seconds to minutes
 * and would freeze every other extension. The extension starts one worker per job.
 */
const { kind, root } = workerData as { kind: 'audit' | 'plan'; root: string };
(kind === 'audit' ? auditWorkspace(root) : planWorkspaceFixes(root)).then(
  (result) => parentPort!.postMessage({ result }),
  (e: unknown) => parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) }),
);
