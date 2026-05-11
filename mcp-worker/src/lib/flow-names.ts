export const FLOWS = Object.freeze({
  MCP_HEALTH: 'MCP/Health',
  MCP_POST: 'MCP/Post',
});

export function mcpToolFlow(toolName: string): string {
  return `MCP/${toolName}`;
}
