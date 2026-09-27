import type { ProfileSnapshot, QualificationResult, QualificationRules } from './types';

function includesAny(haystack: string, needles: string[]): boolean {
  if (!needles.length) return true;
  const lower = haystack.toLowerCase();
  return needles.some((n) => n.trim() && lower.includes(n.trim().toLowerCase()));
}

function includesNone(haystack: string, needles: string[]): boolean {
  if (!needles.length) return true;
  const lower = haystack.toLowerCase();
  return needles.every((n) => !n.trim() || !lower.includes(n.trim().toLowerCase()));
}

/**
 * Pure business logic — no browser dependency.
 */
export function evaluateProfile(
  profile: ProfileSnapshot,
  rules: QualificationRules,
): QualificationResult {
  const reasons: string[] = [];

  if (rules.verifiedRequired && !profile.isVerified) {
    reasons.push('Verified badge required but not visible');
  }

  if (profile.followers === null) {
    // Unknown follower count — do not reject; AI / other rules decide
  } else {
    if (profile.followers < rules.minFollowers) {
      reasons.push(`Followers ${profile.followers} below minimum ${rules.minFollowers}`);
    }
    if (profile.followers > rules.maxFollowers) {
      reasons.push(`Followers ${profile.followers} above maximum ${rules.maxFollowers}`);
    }
  }

  if (rules.accountVisibility === 'public') {
    if (profile.isPrivate === true) {
      reasons.push('Account is private; public required');
    }
  } else if (rules.accountVisibility === 'private') {
    if (profile.isPrivate !== true) {
      reasons.push('Account is not private; private required');
    }
  }

  const bioHaystack = `${profile.bio} ${profile.locationText}`;
  if (rules.requiredBioKeywords.length && !includesAny(profile.bio, rules.requiredBioKeywords)) {
    reasons.push(`Bio missing required keywords: ${rules.requiredBioKeywords.join(', ')}`);
  }
  if (!includesNone(profile.bio, rules.excludedBioKeywords)) {
    reasons.push(`Bio contains excluded keywords: ${rules.excludedBioKeywords.join(', ')}`);
  }
  if (
    rules.requiredLocationKeywords.length &&
    !includesAny(bioHaystack, rules.requiredLocationKeywords)
  ) {
    reasons.push(
      `Location/bio missing required location keywords: ${rules.requiredLocationKeywords.join(', ')}`,
    );
  }
  if (rules.requiredAccountTypeKeywords.length) {
    const hintText = profile.accountTypeHints.join(' ') || profile.bio;
    if (!includesAny(hintText, rules.requiredAccountTypeKeywords)) {
      reasons.push(
        `Account type hints missing required keywords: ${rules.requiredAccountTypeKeywords.join(', ')}`,
      );
    }
  }

  return {
    qualifies: reasons.length === 0,
    reasons: reasons.length ? reasons : ['Matches all configured qualification rules'],
  };
}
