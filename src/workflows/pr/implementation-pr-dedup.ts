export interface ExistingImplementationPr {
  number: number;
  matchedTokens: string[];
}

export interface OpenPullRequestText {
  pullRequestNumber: number;
  headBranch?: string;
  title?: string;
  body?: string;
}

const MIN_FUZZY_FINGERPRINT_TOKENS = 2;
const MAX_FUZZY_FINGERPRINT_TOKENS = 3;
const MIN_SHARED_FINGERPRINT_TOKENS = 2;

const STOP_TOKENS = new Set([
  'acceptance',
  'after',
  'activity',
  'agent',
  'before',
  'because',
  'between',
  'branch',
  'code',
  'completion',
  'contains',
  'criteria',
  'current',
  'data',
  'dispatch',
  'environment',
  'error',
  'evidence',
  'execute',
  'executes',
  'existing',
  'expected',
  'failed',
  'failure',
  'fingerprint',
  'from',
  'github',
  'handoff',
  'history',
  'implementation',
  'into',
  'issue',
  'local',
  'lookup',
  'message',
  'needed',
  'only',
  'production',
  'proxy',
  'request',
  'review',
  'root',
  'run',
  'service',
  'source',
  'status',
  'summary',
  'temporal',
  'through',
  'while',
  'with',
  'without',
  'workflow',
  'workflows',
]);

export function matchOpenImplementationPr(
  signature: ProblemSignature,
  openPullRequests: readonly OpenPullRequestText[],
): ExistingImplementationPr | undefined {
  for (const pr of openPullRequests) {
    const match = matchImplementationPr(signature, pr);
    if (match) return match;
  }
  return undefined;
}

function matchImplementationPr(
  signature: ProblemSignature,
  pr: OpenPullRequestText,
): ExistingImplementationPr | undefined {
  const text = prText(pr);
  if (!looksLikeImplementationPr(pr, text)) return undefined;

  const exactFingerprintMatch = containsPhrase(text, signature.fingerprint);
  const serviceMatch = containsPhrase(text, signature.service);
  const environmentMatch = environmentAliases(signature.environment).some((environment) =>
    containsPhrase(text, environment),
  );

  if (exactFingerprintMatch && (serviceMatch || environmentMatch)) {
    return { number: pr.pullRequestNumber, matchedTokens: ['fingerprint'] };
  }

  if (!serviceMatch || !environmentMatch) return undefined;

  // Service/env overlap is too broad in monorepos; require issue-specific
  // fingerprint tokens before a match can be claimed.
  const fingerprintTokens = relevantFingerprintTokens(signature);
  if (fingerprintTokens.size < MIN_FUZZY_FINGERPRINT_TOKENS) return undefined;

  const matchedFingerprintTokens = Array.from(fingerprintTokens).filter((token) =>
    containsToken(text, token),
  );
  const requiredFingerprintMatches = Math.min(MAX_FUZZY_FINGERPRINT_TOKENS, fingerprintTokens.size);
  if (matchedFingerprintTokens.length < requiredFingerprintMatches) return undefined;

  return { number: pr.pullRequestNumber, matchedTokens: matchedFingerprintTokens };
}

function looksLikeImplementationPr(pr: OpenPullRequestText, text = prText(pr)): boolean {
  const headRef = pr.headBranch ?? '';
  return (
    headRef.startsWith('agent/') ||
    containsPhrase(text, 'source log review run id') ||
    containsPhrase(text, 'fix implementation run id') ||
    /\bagent-run-id\b/i.test(text.raw)
  );
}

function environmentAliases(environment: string): string[] {
  const normalized = normalizeForPhrase(environment);
  if (normalized === 'prod' || normalized === 'production')
    return [environment, 'prod', 'production'];
  return [environment];
}

function relevantFingerprintTokens(signature: ProblemSignature): Set<string> {
  return fingerprintTokens(signature.fingerprint, signature.service, signature.environment);
}

// fingerprintTokens strips the service, the environment and generic terms, which are
// matched separately and would otherwise inflate the overlap in a monorepo.
function fingerprintTokens(fingerprint: string, service: string, environment: string): Set<string> {
  const excluded = new Set([
    ...STOP_TOKENS,
    ...tokensFromText(service),
    ...environmentAliases(environment).flatMap((alias) => tokensFromText(alias)),
  ]);
  const tokens = new Set<string>();
  for (const token of tokensFromText(fingerprint)) {
    if (token.length < 3 || excluded.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

export interface ProblemSignature {
  fingerprint: string;
  service: string;
  environment: string;
  likelyFilesOrSymbols: string[];
}

// isSameProblem requires a shared error signal and a shared code location, so the same
// log at a different endpoint is not read as the same problem.
export function isSameProblem(a: ProblemSignature, b: ProblemSignature): boolean {
  return shareErrorSignal(a, b) && shareCodeLocation(a, b);
}

function shareErrorSignal(a: ProblemSignature, b: ProblemSignature): boolean {
  const aTokens = relevantFingerprintTokens(a);
  const bTokens = relevantFingerprintTokens(b);
  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared += 1;
  }
  return shared >= MIN_SHARED_FINGERPRINT_TOKENS;
}

function shareCodeLocation(a: ProblemSignature, b: ProblemSignature): boolean {
  const aLocations = new Set(a.likelyFilesOrSymbols.map(normalizeForPhrase).filter(Boolean));
  return b.likelyFilesOrSymbols.some((location) => aLocations.has(normalizeForPhrase(location)));
}

function prText(pr: OpenPullRequestText): { raw: string; normalized: string } {
  const raw = [pr.title, pr.body, pr.headBranch]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return {
    raw,
    normalized: normalizeForPhrase(raw),
  };
}

function containsPhrase(text: ReturnType<typeof prText>, phrase: string): boolean {
  const normalizedPhrase = normalizeForPhrase(phrase);
  if (!normalizedPhrase) return false;
  return new RegExp(`(^| )${escapeRegExp(normalizedPhrase)}( |$)`).test(text.normalized);
}

function containsToken(text: ReturnType<typeof prText>, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(text.normalized);
}

function tokensFromText(text: string): string[] {
  return normalizeForPhrase(text).split(' ').filter(Boolean);
}

function normalizeForPhrase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
