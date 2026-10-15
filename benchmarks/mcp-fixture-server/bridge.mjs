// Only this transport bridge enters the Runner workspace. No fixture or oracle.
import fs from 'node:fs';
import readline from 'node:readline';

const connection = JSON.parse(
  fs.readFileSync(
    new URL('./.fixture-connection.json', import.meta.url),
    'utf8',
  ),
);
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    const response = await fetch(connection.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('fixture_unavailable');
    process.stdout.write(JSON.stringify(await response.json()) + '\n');
  } catch {
    if (request?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: 'fixture transport failed' },
        }) + '\n',
      );
  }
}
