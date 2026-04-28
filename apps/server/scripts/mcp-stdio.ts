import readline from 'readline';
import { detectProjectContext } from './project-context.ts';

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
    const proxiedRequest = withProjectContext(rpcRequest);
    
    // Intercept standard MCP initialization since the backend only implements tools/list and tools/call
    if (proxiedRequest.method === 'initialize') {
      console.log(JSON.stringify({
        jsonrpc: proxiedRequest.jsonrpc || '2.0',
        id: proxiedRequest.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sprino-proxy', version: '0.0.2' }
        }
      }));
      return;
    }
    if (proxiedRequest.method === 'notifications/initialized') {
      return;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(proxiedRequest)
    });
    
    if (!response.ok) {
      // In JSON-RPC over stdio, errors should ideally be wrapped in a JSON-RPC response,
      // but for a simple proxy, we might just fail.
      const errRes = {
        jsonrpc: proxiedRequest.jsonrpc || '2.0',
        id: proxiedRequest.id || null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withProjectContext(rpcRequest: any): any {
  if (
    rpcRequest?.method !== 'tools/call' ||
    !isRecord(rpcRequest.params) ||
    rpcRequest.params.name !== 'sprino.task.create' ||
    !isRecord(rpcRequest.params.arguments)
  ) {
    return rpcRequest;
  }

  const args = rpcRequest.params.arguments;
  if (typeof args.project_id === 'string' || typeof args.repo_path === 'string') {
    return rpcRequest;
  }

  const context = detectProjectContext();
  if (!context.project_id && !context.repo_path) return rpcRequest;

  return {
    ...rpcRequest,
    params: {
      ...rpcRequest.params,
      arguments: { ...args, ...context },
    },
  };
}
