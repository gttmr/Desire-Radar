import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export class PromptLoader {
  private cache = new Map<string, string>();

  constructor(private readonly agentsDir: string) {}

  async loadAgent(agentName: string): Promise<string> {
    const cached = this.cache.get(agentName);
    if (cached) return cached;

    const filePath = join(this.agentsDir, `${agentName}.md`);
    const content = await readFile(filePath, 'utf-8');
    this.cache.set(agentName, content);
    return content;
  }

  async loadProviderOverride(
    agentName: string,
    provider: string,
  ): Promise<string | null> {
    const key = `${agentName}__${provider}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const filePath = join(this.agentsDir, `${agentName}.${provider}.md`);
    if (!existsSync(filePath)) return null;

    const content = await readFile(filePath, 'utf-8');
    this.cache.set(key, content);
    return content;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
