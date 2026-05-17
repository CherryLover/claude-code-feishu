import fs from 'fs';
import path from 'path';
import { CredentialConfig, CredentialsConfig } from './types.js';

// 所有由凭证驱动的 AI 相关环境变量。
// 这些 key 不再由 .env / 环境变量控制，而是由 credentials.json 决定。
const AI_ENV_KEYS = [
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
] as const;

let activeCredential: CredentialConfig | null = null;

export function loadCredentialsConfig(): CredentialsConfig {
  const configPath = path.resolve(process.cwd(), 'credentials.json');

  if (!fs.existsSync(configPath)) {
    console.error('❌ 未找到 credentials.json 配置文件');
    console.error('请参考 credentials.example.json 创建配置文件');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as CredentialsConfig;
    validateCredentialsConfig(config);
    return config;
  } catch (error) {
    console.error('❌ credentials.json 解析失败:', error);
    process.exit(1);
  }
}

function validateCredentialsConfig(config: CredentialsConfig): void {
  if (!config.credentials || !Array.isArray(config.credentials)) {
    throw new Error('配置文件格式错误: credentials 必须是数组');
  }
  if (config.credentials.length === 0) {
    throw new Error('credentials.json 中没有凭证');
  }

  const ids = new Set<string>();
  for (const cred of config.credentials) {
    if (!cred.id || typeof cred.id !== 'string') {
      throw new Error('凭证缺少 id 字段');
    }
    if (ids.has(cred.id)) {
      throw new Error(`凭证 id 重复: ${cred.id}`);
    }
    ids.add(cred.id);

    if (cred.engine !== 'claude' && cred.engine !== 'codex') {
      throw new Error(`凭证 [${cred.id}] 的 engine 必须是 claude 或 codex`);
    }
    if (cred.mode !== 'subscription' && cred.mode !== 'api') {
      throw new Error(`凭证 [${cred.id}] 的 mode 必须是 subscription 或 api`);
    }
    if (cred.mode === 'api' && (!cred.apiKey || typeof cred.apiKey !== 'string')) {
      throw new Error(`凭证 [${cred.id}] 为 api 模式时必须提供 apiKey`);
    }
  }
}

export function resolveCredential(id: string, config: CredentialsConfig): CredentialConfig {
  const cred = config.credentials.find((c) => c.id === id);
  if (!cred) {
    const available = config.credentials.map((c) => c.id).join(', ');
    throw new Error(`找不到凭证 id="${id}"，可用：${available}`);
  }
  return cred;
}

/**
 * 把凭证落到当前进程/Worker 的环境变量里，供 SDK 读取。
 * - 先清空所有 AI 相关 env，保证干净的起点（尤其是 subscription 模式必须没有 key）
 * - 再按引擎与模式注入
 * 注意：每个 Agent 跑在独立 Worker 线程，process.env 是各自的拷贝，互不污染。
 */
export function applyCredentialEnv(cred: CredentialConfig): void {
  for (const key of AI_ENV_KEYS) {
    delete process.env[key];
  }

  process.env.AI_PROVIDER = cred.engine;

  if (cred.engine === 'claude') {
    if (cred.mode === 'api') {
      process.env.ANTHROPIC_API_KEY = cred.apiKey;
      if (cred.baseUrl) {
        process.env.ANTHROPIC_BASE_URL = cred.baseUrl;
      }
    }
    // subscription: 不设任何 key，Claude Code CLI 会回退到 ~/.claude 登录态
  } else {
    if (cred.mode === 'api') {
      process.env.OPENAI_API_KEY = cred.apiKey;
      process.env.CODEX_API_KEY = cred.apiKey;
      if (cred.baseUrl) {
        process.env.OPENAI_BASE_URL = cred.baseUrl;
      }
    }
    // subscription: 不设任何 key，Codex CLI 会回退到 ~/.codex 登录态
  }

  activeCredential = cred;
}

export function getActiveCredential(): CredentialConfig | null {
  return activeCredential;
}

export interface CredentialEnvSnapshot {
  env: Record<string, string | undefined>;
  credential: CredentialConfig | null;
}

// 单进程场景（Web API）下临时切换凭证后用于还原
export function snapshotCredentialEnv(): CredentialEnvSnapshot {
  const env: Record<string, string | undefined> = {};
  for (const key of AI_ENV_KEYS) {
    env[key] = process.env[key];
  }
  return { env, credential: activeCredential };
}

export function restoreCredentialEnv(snapshot: CredentialEnvSnapshot): void {
  for (const key of AI_ENV_KEYS) {
    const value = snapshot.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  activeCredential = snapshot.credential;
}
