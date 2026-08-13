import { ParsedFunction } from '../tier1/astParser';

const BUSINESS_LOGIC_KEYWORDS = [
  'calculate', 'calc',
  'validate', 'validation',
  'apply',
  'transition', 'transit',
  'process',
  'compute',
  'charge', 'price', 'discount', 'cost', 'fee',
  'order', 'status',
  'auth', 'authorize', 'permission', 'role',
  'limit', 'quota', 'threshold',
  'balance', 'payment', 'refund',
  'schedule', 'expire',
];

export function isInteresting(fn: ParsedFunction): boolean {
  const nameLower = fn.name.toLowerCase();
  const bodyLower = fn.text.toLowerCase();

  const hasKeyword = BUSINESS_LOGIC_KEYWORDS.some(kw =>
    nameLower.includes(kw) || bodyLower.includes(kw)
  );

  // Keyword match is sufficient; docstring improves LLM quality but is not required
  return hasKeyword;
}
