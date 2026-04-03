import dotenv from 'dotenv';

dotenv.config({ override: true, quiet: true });

export const SUPPORTED_AI_PROVIDERS = ['claude', 'codex'] as const;
export type AiProvider = typeof SUPPORTED_AI_PROVIDERS[number];

interface ApplyProviderEnvOptions {
  runtimeNamespace?: string;
}

const COMMON_OVERRIDE_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'NOTIFY_USER_ID',
  'AUTHORIZED_USER_NAME',
  'MESSAGE_WORKSPACE',
  'DEVELOPER_WORKSPACE',
  'FEISHU_REPLY_FORMAT',
  'FEISHU_REPLY_SHOW_USAGE',
  'FEISHU_REPLY_ACK_REACTION',
  'FEISHU_REPLY_ACK_EMOJI',
  'WORKSPACE',
  'SCHEDULER_ENABLED',
  'SCHEDULER_DB_PATH',
  'SCHEDULER_TASK_TIMEOUT_MS',
  'CHAT_TURN_TIMEOUT_MS',
  'INSTANCE_TAG',
] as const;

function isAiProvider(value: string): value is AiProvider {
  return (SUPPORTED_AI_PROVIDERS as readonly string[]).includes(value);
}

export function parseAiProviders(value: string | undefined): AiProvider[] {
  const raw = value?.trim() || 'claude';
  const parts = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) {
    return ['claude'];
  }

  const providers: AiProvider[] = [];
  for (const part of parts) {
    if (!isAiProvider(part)) {
      throw new Error(`不支持的 AI_PROVIDER: ${part}`);
    }
    if (!providers.includes(part)) {
      providers.push(part);
    }
  }

  return providers;
}

function getProviderPrefix(provider: AiProvider): string {
  return provider.toUpperCase();
}

function assignEnvFromOverride(provider: AiProvider, key: string): void {
  const overrideKey = `${getProviderPrefix(provider)}_${key}`;
  const overrideValue = process.env[overrideKey];
  if (overrideValue !== undefined) {
    process.env[key] = overrideValue;
  }
}

function applyProviderApiEnv(provider: AiProvider): void {
  if (provider === 'claude') {
    assignEnvFromOverride(provider, 'ANTHROPIC_API_KEY');
    assignEnvFromOverride(provider, 'ANTHROPIC_BASE_URL');
    return;
  }

  assignEnvFromOverride(provider, 'OPENAI_API_KEY');
  assignEnvFromOverride(provider, 'OPENAI_BASE_URL');
  assignEnvFromOverride(provider, 'CODEX_API_KEY');
}

function applyProviderCommonEnv(provider: AiProvider): void {
  for (const key of COMMON_OVERRIDE_KEYS) {
    assignEnvFromOverride(provider, key);
  }
}

export function applyProviderEnvOverrides(provider: AiProvider, options: ApplyProviderEnvOptions = {}): void {
  process.env.AI_PROVIDER = provider;

  if (options.runtimeNamespace) {
    process.env.BOT_RUNTIME_NAMESPACE = options.runtimeNamespace;
  } else {
    delete process.env.BOT_RUNTIME_NAMESPACE;
  }

  applyProviderApiEnv(provider);
  applyProviderCommonEnv(provider);
}
