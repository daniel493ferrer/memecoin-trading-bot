import { fetchJson } from './utils.js';

interface GoPlusToken {
  is_honeypot?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  owner_change_balance?: string;
  transfer_pausable?: string;
  hidden_owner?: string;
  is_blacklisted?: string;
}

/** Highest buy or sell tax accepted, as a fraction. */
const MAX_TAX = 0.1;

/**
 * Honeypot and hidden-tax check for EVM tokens via the free GoPlus token
 * security API. `checked` is false when GoPlus has no data or is
 * unreachable; callers decide whether that is acceptable.
 */
export async function evmTokenSafety(
  goplusChainId: string,
  address: string,
): Promise<{ checked: boolean; reasons: string[] }> {
  let token: GoPlusToken | undefined;
  try {
    const body = await fetchJson<{ code?: number; result?: Record<string, GoPlusToken> }>(
      `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${address}`,
    );
    token = body.result?.[address.toLowerCase()];
  } catch {
    return { checked: false, reasons: [] };
  }
  if (!token) return { checked: false, reasons: [] };

  const reasons: string[] = [];
  const yes = (v?: string) => v === '1';
  if (yes(token.is_honeypot)) reasons.push('honeypot (cannot sell)');
  if (yes(token.cannot_sell_all)) reasons.push('cannot sell the full balance');
  if (Number(token.buy_tax) > MAX_TAX) reasons.push(`buy tax ${(Number(token.buy_tax) * 100).toFixed(0)}%`);
  if (Number(token.sell_tax) > MAX_TAX) reasons.push(`sell tax ${(Number(token.sell_tax) * 100).toFixed(0)}%`);
  if (yes(token.owner_change_balance)) reasons.push('owner can change balances');
  if (yes(token.transfer_pausable)) reasons.push('transfers can be paused');
  if (yes(token.hidden_owner)) reasons.push('hidden owner');
  if (yes(token.is_blacklisted)) reasons.push('owner can blacklist holders');
  return { checked: true, reasons };
}
