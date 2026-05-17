export type AiEngine = 'claude' | 'codex';
export type CredentialMode = 'subscription' | 'api';

export interface CredentialConfig {
  id: string;
  engine: AiEngine;
  // subscription: 复用本机 ~/.claude 或 ~/.codex 的登录态，不带 key
  // api: 使用第三方 / 中转 API（apiKey 必填，baseUrl/model 可选）
  mode: CredentialMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface CredentialsConfig {
  credentials: CredentialConfig[];
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  // 引用 credentials.json 中的某个凭证 id，引擎(claude/codex)由凭证决定
  credential: string;
  workspace: string;
  notifyUserId?: string;
  feishu: {
    appId: string;
    appSecret: string;
  };
}

export interface AgentsConfig {
  agents: AgentConfig[];
}
