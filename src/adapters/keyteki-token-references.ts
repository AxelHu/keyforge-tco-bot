/** Exact public token-wire identities, bound to independently implemented local templates.
 * Metadata-only ToC references stay unsupported. This never admits a token by translated name.
 * Pinned source: keyteki/keyteki 361c085bcd401c20976ee9bcc4e4e5b8c061d56c, ToC 855.
 */
import { TOC_TOKEN_FACTS } from '../knowledge/token-facts.js';
import { TOC_TOKEN_TEMPLATES } from '../knowledge/token-facts.js';
import type { CardDefinition } from '../contracts/observation.js';
const known = new Map(TOC_TOKEN_FACTS.map((c) => [c.id.slice('toc-token-'.length), c]));
const implemented = new Map(TOC_TOKEN_TEMPLATES.map((c) => [c.id.slice('toc-token-'.length), c]));
export function resolveExternalKeytekiToken(
  raw: Record<string, unknown>,
  context: 'reference' | 'card',
): CardDefinition | null | undefined {
  if (typeof raw.id === 'string' && raw.id.startsWith('toc-token-')) return null;
  if (typeof raw.id !== 'string' || !known.has(raw.id)) return undefined;
  const token = implemented.get(raw.id);
  // A known unsupported identity or conflicting facts must never fall through to another name.
  if (
    !token ||
    (context === 'card' ? raw.type !== 'creature' || raw.isToken !== true : raw.type !== 'token creature') ||
    (raw.number !== undefined && raw.number !== token.number) ||
    (raw.printedHouse !== undefined && raw.printedHouse !== token.house) ||
    (raw.expansion !== undefined && raw.expansion !== 855) ||
    (raw.powerPrinted !== undefined && raw.powerPrinted !== token.power) ||
    // The pinned referee serializes no printed armor as null (Alpha-Gamma).
    (raw.armorPrinted !== undefined &&
      (raw.armorPrinted === null ? token.armor !== 0 : raw.armorPrinted !== token.armor)) ||
    (raw.cardPrintedAmber !== undefined && raw.cardPrintedAmber !== token.amber)
  )
    return null;
  return token;
}
