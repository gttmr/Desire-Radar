import { describe, expect, it } from 'vitest';
import { resolvePolicyDir } from '../src/config/index.js';

describe('resolvePolicyDir', () => {
  it('resolves the source policy directory from the package source tree', () => {
    const resolved = resolvePolicyDir(
      '/mnt/c/Users/ilmas/workspace/Agentic-World/packages/mcp-orchestrator/src/config',
    );

    expect(resolved).toBe(
      '/mnt/c/Users/ilmas/workspace/Agentic-World/packages/mcp-orchestrator/policy',
    );
  });

  it('resolves the source policy directory from the dist/mcp-orchestrator tree', () => {
    const resolved = resolvePolicyDir(
      '/mnt/c/Users/ilmas/workspace/Agentic-World/packages/mcp-orchestrator/dist/mcp-orchestrator/src/config',
    );

    expect(resolved).toBe(
      '/mnt/c/Users/ilmas/workspace/Agentic-World/packages/mcp-orchestrator/policy',
    );
  });
});
