import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuDomainInfo {
  key: 'feishu' | 'lark';
  sdkDomain: lark.Domain;
  baseUrl: string;
}

export const FEISHU_STREAMING_ELEMENT_ID = 'streaming_content';

function normalizeDomain(input?: string | null): string {
  return (input || 'feishu').trim().toLowerCase().replace(/\/+$/, '');
}

export function resolveFeishuDomain(input?: string | null): FeishuDomainInfo {
  const normalized = normalizeDomain(input);

  if (
    normalized === 'lark'
    || normalized.includes('larksuite')
    || normalized.includes('open.larksuite.com')
  ) {
    return {
      key: 'lark',
      sdkDomain: lark.Domain.Lark,
      baseUrl: 'https://open.larksuite.com',
    };
  }

  return {
    key: 'feishu',
    sdkDomain: lark.Domain.Feishu,
    baseUrl: 'https://open.feishu.cn',
  };
}

export function buildCardReferenceContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } });
}

export function buildCardCreateData(cardJson: string): {
  type: 'card_json';
  data: string;
} {
  return {
    type: 'card_json',
    data: cardJson,
  };
}

export function buildCardSettingsData(
  config: Record<string, unknown>,
  sequence: number,
): {
  settings: string;
  sequence: number;
} {
  return {
    settings: JSON.stringify({ config }),
    sequence,
  };
}

export function buildCardUpdateData(
  cardJson: string,
  sequence: number,
): {
  card: {
    type: 'card_json';
    data: string;
  };
  sequence: number;
} {
  return {
    card: {
      type: 'card_json',
      data: cardJson,
    },
    sequence,
  };
}
