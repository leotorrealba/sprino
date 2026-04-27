import readline from 'readline';

const endpoint = process.env.SPRINO_MCP_ENDPOINT || 'http://localhost:3001/mcp';
const token = process.env.SPRINO_MCP_TOKEN || 'dev-claude-token-please-change';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const rpcRequest = JSON.parse(line);
    
    // Intercept standard MCP initialization since the backend only implements tools/list and tools/call
    if (rpcRequest.method === 'initialize') {
      console.log(JSON.stringify({
        jsonrpc: rpcRequest.jsonrpc || '2.0',
        id: rpcRequest.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sprino-proxy', version: '0.0.1' }
        }
      }));
      return;
    }
    if (rpcRequest.method === 'notifications/initialized') {
      return;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(rpcRequest)
    });
    
    if (!response.ok) {
      // In JSON-RPC over stdio, errors should ideally be wrapped in a JSON-RPC response,
      // but for a simple proxy, we might just fail.
      const errRes = {
        jsonrpc: rpcRequest.jsonrpc || '2.0',
        id: rpcRequest.id || null,
        error: { code: -32603, message: `HTTP error: ${response.status}` }
      };
      console.log(JSON.stringify(errRes));
      return;
    }
    
    const text = await response.text();
    // Only output the actual JSON response to stdout.
    console.log(text);
  } catch (error) {
    // Silent drop or stderr
    console.error('Error proxying:', error);
  }
});
