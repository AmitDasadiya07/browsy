/**
 * Pure message-template helpers (no browser dependency).
 */

export function resolveGreetingName(options: {
  firstName: string | null | undefined;
  displayedName: string;
  username?: string;
}): string {
  const first = options.firstName?.trim();
  if (first) return first;

  const display = (options.displayedName || '').trim();
  if (!display) return options.username?.trim() || 'there';

  const companyHints =
    /\b(clinic|hospital|lab|labs|group|company|inc|llc|ltd|studio|centre|center|dermatology|medical|pharma|brand|official|team|institute|university|college|foundation)\b/i;
  const looksLikePerson =
    /^[\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*){0,3}$/u.test(display) &&
    !companyHints.test(display) &&
    display.length < 40;

  if (looksLikePerson) {
    return display.split(/\s+/)[0] || display;
  }

  if (companyHints.test(display) || display.length > 28 || /\+|&/.test(display)) {
    const cleaned = display.replace(/\s+/g, ' ').trim();
    if (/team$/i.test(cleaned)) return cleaned;
    return `${cleaned} team`;
  }

  return display;
}

export function applyMessageTemplate(
  template: string,
  names: {
    firstName: string;
    displayedName: string;
    greetingName?: string;
    username?: string;
  },
): string {
  const greeting =
    names.greetingName ||
    resolveGreetingName({
      firstName: names.firstName,
      displayedName: names.displayedName,
      username: names.username,
    });
  return template
    .replaceAll('{greeting_name}', greeting)
    .replaceAll('{first_name}', names.firstName || greeting)
    .replaceAll('{name}', names.displayedName || greeting);
}
