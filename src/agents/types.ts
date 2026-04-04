export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  provider: 'claude' | 'codex';
  workspace: string;
  feishu: {
    appId: string;
    appSecret: string;
  };
}

export interface AgentsConfig {
  agents: AgentConfig[];
}
