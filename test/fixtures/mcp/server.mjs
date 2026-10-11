// Minimal stdio MCP server for tests: answers initialize and a paginated tools/list.
import { createInterface } from 'node:readline';

const pages = [
  [{ name: 'search_docs', description: 'Search the project documentation.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  [{ name: 'open_ticket', description: 'Open a ticket in the tracker.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } } }],
];
console.log('not json: servers sometimes log to stdout');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize')
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (msg.method === 'tools/list') {
    const page = msg.params?.cursor ? 1 : 0;
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: pages[page], ...(page === 0 ? { nextCursor: 'p2' } : {}) } });
  }
});
