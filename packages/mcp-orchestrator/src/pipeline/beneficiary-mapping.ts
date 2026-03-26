import type {
  AgentTurn,
  BeneficiaryCandidate,
  BeneficiaryCategory,
  BeneficiaryMapping,
} from '@agentic/shared-types';

const CLAIM_PREFIX_MAP: Record<string, BeneficiaryCategory> = {
  direct_winner: 'direct_winner',
  public_beneficiary: 'public_beneficiary',
  second_order_beneficiary: 'second_order_beneficiary',
};

function parseBeneficiaryClaim(claim: string): {
  category?: BeneficiaryCategory;
  name?: string;
  rationale?: string;
  specialKey?: 'missing_monetization_link' | 'invalidation_point';
  specialValue?: string;
} {
  const normalized = claim.trim();
  const match = normalized.match(
    /^(direct_winner|public_beneficiary|second_order_beneficiary)\s*:\s*([^|]+?)(?:\s*\|\s*rationale\s*:\s*(.+))?$/i,
  );
  if (match) {
    const rawCategory = match[1]!.toLowerCase();
    return {
      category: CLAIM_PREFIX_MAP[rawCategory],
      name: match[2]!.trim(),
      rationale: match[3]?.trim() ?? '',
    };
  }

  const special = normalized.match(
    /^(missing_monetization_link|invalidation_point)\s*:\s*(.+)$/i,
  );
  if (special) {
    return {
      specialKey: special[1]!.toLowerCase() as 'missing_monetization_link' | 'invalidation_point',
      specialValue: special[2]!.trim(),
    };
  }

  return {};
}

export function buildBeneficiaryMapping(turn?: AgentTurn): BeneficiaryMapping | null {
  if (!turn) {
    return null;
  }

  const direct_winners: BeneficiaryCandidate[] = [];
  const public_beneficiaries: BeneficiaryCandidate[] = [];
  const second_order_beneficiaries: BeneficiaryCandidate[] = [];
  let missing_monetization_link: string | null = null;
  let invalidation_point: string | null = null;

  for (const claim of turn.response.claims) {
    const parsed = parseBeneficiaryClaim(claim.claim);
    if (parsed.specialKey === 'missing_monetization_link') {
      missing_monetization_link = parsed.specialValue ?? null;
      continue;
    }
    if (parsed.specialKey === 'invalidation_point') {
      invalidation_point = parsed.specialValue ?? null;
      continue;
    }
    if (!parsed.category || !parsed.name) {
      continue;
    }

    const entry: BeneficiaryCandidate = {
      name: parsed.name,
      category: parsed.category,
      rationale: parsed.rationale ?? '',
      supporting_evidence: claim.supporting_evidence,
      confidence: claim.confidence,
    };
    switch (parsed.category) {
      case 'direct_winner':
        direct_winners.push(entry);
        break;
      case 'public_beneficiary':
        public_beneficiaries.push(entry);
        break;
      case 'second_order_beneficiary':
        second_order_beneficiaries.push(entry);
        break;
    }
  }

  return {
    summary: turn.response.summary,
    direct_winners,
    public_beneficiaries,
    second_order_beneficiaries,
    missing_monetization_link,
    invalidation_point,
    source_agent: turn.agent_name,
  };
}

export function summarizeBeneficiaryMapping(mapping: BeneficiaryMapping | null): string {
  if (!mapping) {
    return 'No beneficiary mapping available.';
  }

  const lines = [`summary: ${mapping.summary}`];
  if (mapping.direct_winners.length > 0) {
    lines.push(
      `direct_winners: ${mapping.direct_winners
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }
  if (mapping.public_beneficiaries.length > 0) {
    lines.push(
      `public_beneficiaries: ${mapping.public_beneficiaries
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }
  if (mapping.second_order_beneficiaries.length > 0) {
    lines.push(
      `second_order_beneficiaries: ${mapping.second_order_beneficiaries
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }
  if (mapping.missing_monetization_link) {
    lines.push(`missing_monetization_link: ${mapping.missing_monetization_link}`);
  }
  if (mapping.invalidation_point) {
    lines.push(`invalidation_point: ${mapping.invalidation_point}`);
  }
  return lines.join('\n');
}

export function isWeakBeneficiaryMapping(mapping: BeneficiaryMapping | null): boolean {
  if (!mapping) {
    return true;
  }
  return (
    mapping.direct_winners.length === 0 &&
    mapping.public_beneficiaries.length === 0 &&
    mapping.second_order_beneficiaries.length === 0
  );
}
