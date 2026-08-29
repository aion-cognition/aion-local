import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_BASE = 'http://127.0.0.1:8765';

const OFF_TOPIC = [
  'how do I re-tension a bicycle wheel spoke',
  'quantum error correction surface codes for topological qubits',
  'zzqxwv plortnak vugglesnorf',
  'how many albatrosses did the Reykjavik ferry log in 1974',
];

const ON_TOPIC = [
  'what did we decide about the outbox poller',
  'what is the stripe webhook retry limit',
  'where is the billing service deployed',
];

async function open() {
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`));
  const client = new Client({ name: 'live-check', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function pack(result) {
  const structured = result.structuredContent ?? {};
  const items = ['facts', 'episodes', 'narratives', 'preferences', 'resonant'].flatMap(
    (bucket) => structured[bucket] ?? [],
  );
  return { structured, items };
}

const health = await (await fetch(`${URL_BASE}/health`)).json();
console.log('HEALTH', JSON.stringify(health, null, 2));

const { client, transport } = await open();
const sessionId = transport.sessionId;
console.log('session', sessionId);

for (const query of OFF_TOPIC) {
  const result = await client.callTool({ name: 'recall', arguments: { query } });
  const { structured, items } = pack(result);
  console.log(
    `OFF "${query}" -> ${items.length} items, ${structured.metadata?.token_estimate} tokens, ` +
      `admission ${JSON.stringify(structured.metadata?.admission)}`,
  );
  for (const item of items.slice(0, 4)) {
    console.log(`    [${item.rationale.method} ${item.confidence.toFixed(2)}] ${item.content.slice(0, 70)}`);
  }
}

for (const query of ON_TOPIC) {
  const result = await client.callTool({ name: 'recall', arguments: { query } });
  const { structured, items } = pack(result);
  console.log(`ON  "${query}" -> ${items.length} items, ${structured.metadata?.token_estimate} tokens`);
  for (const item of items.slice(0, 3)) {
    console.log(`    [${item.rank} ${item.currency} ${item.rationale.method} ${item.confidence.toFixed(2)}] ${item.content.slice(0, 70)}`);
  }
}

await transport.terminateSession();
await client.close();

console.log('READ-ONLY SESSION:', sessionId);
