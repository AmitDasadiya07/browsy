/**
 * Centralized LinkedIn web UI selectors.
 * All automation targets visible DOM only — no private/internal API endpoints.
 * Update this file when LinkedIn changes visible markup.
 */

export const LI_SELECTORS = {
  // ── Login / session ──────────────────────────────────────────────────────────
  loginInput: 'input[name="session_key"], input[name="email"], input[id="username"]',
  feedIndicator: 'a[href*="/feed"], .global-nav__me, nav.global-nav',
  myNetworkLink: 'a[href*="/mynetwork"]',

  // ── Security / challenge surfaces — stop immediately if detected ─────────────
  security: {
    challengeUrl: '/checkpoint/',
    verificationUrl: '/challenge/',
    captchaUrl: '/security/',
    captchaIframe: 'iframe[src*="captcha"], iframe[src*="recaptcha"]',
    challengeText:
      'text=/verify your identity|security check|unusual activity|confirm.*you|captcha|suspicious/i',
    restrictionText:
      'text=/your account has been restricted|temporarily.*restricted|limited.*access/i',
  },

  // ── Search results ───────────────────────────────────────────────────────────
  // People search page results container
  searchResultList: '.search-results-container, .reusable-search__entity-result-list',
  searchResultItem: 'li.reusable-search__result-container, li[class*="result"]',
  searchResultLink: 'a[href*="/in/"]',
  searchResultName:
    'span.entity-result__title-text, .entity-result__title-line a span[aria-hidden="true"]',
  searchResultSubtitle: '.entity-result__primary-subtitle',
  searchResultSecondLine: '.entity-result__secondary-subtitle',
  searchPaginationNext: 'button[aria-label="Next"], a[aria-label="Next"]',

  // ── Profile page ─────────────────────────────────────────────────────────────
  profileName: 'h1.text-heading-xlarge, h1[class*="heading"]',
  profileHeadline: '.text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium',
  profileLocation: '.text-body-small.inline.t-black--light.break-words',
  profileAboutSection: '#about ~ div, .pv-about-section, section[data-section="about"]',
  profileAboutText: '#about ~ div .inline-show-more-text, .pv-about-section p',
  profileExperienceSection: '#experience ~ div, section[data-section="experience"]',
  profileFirstExperienceTitle:
    '#experience ~ div li:first-child .mr1.t-bold span[aria-hidden="true"]',
  profileFirstExperienceCompany:
    '#experience ~ div li:first-child .t-14.t-normal span[aria-hidden="true"]',

  // ── Connection actions ────────────────────────────────────────────────────────
  connectButton:
    'button[aria-label*="Connect"], button:has-text("Connect"), .pvs-profile-actions button:has-text("Connect")',
  connectButtonFallback: 'button.artdeco-button--primary:has-text("Connect")',
  moreActionsButton:
    'button[aria-label*="More actions"], button.artdeco-dropdown__trigger:has-text("More")',
  connectInDropdown: 'div[aria-label*="Connect"], li[aria-label*="Connect"]',
  addNoteButton: 'button[aria-label="Add a note"], button:has-text("Add a note")',
  sendWithoutNoteButton:
    'button[aria-label="Send without a note"], button:has-text("Send without a note")',
  sendNowButton: 'button[aria-label="Send now"], button:has-text("Send now")',
  sendButton: 'button[aria-label="Send"], button:has-text("Send")',
  noteTextarea: 'textarea[name="message"], textarea[id*="custom-message"]',
  connectionModalDone: 'button[aria-label*="Dismiss"], button:has-text("Done")',

  // ── Connection status indicators ──────────────────────────────────────────────
  pendingIndicator:
    'button[aria-label*="Pending"], span:has-text("Pending"), .artdeco-inline-feedback:has-text("Pending")',
  connectedIndicator:
    'button[aria-label*="Message"], .pvs-profile-actions button:has-text("Message"), span:has-text("1st")',
  followButton: 'button:has-text("Follow"), button[aria-label*="Follow"]',

  // ── Messaging ────────────────────────────────────────────────────────────────
  messageButton:
    'button[aria-label*="Message"], .pvs-profile-actions button:has-text("Message"), a[href*="/messaging/"]',
  messageComposer:
    'div.msg-form__contenteditable, div[contenteditable="true"][role="textbox"]',
  messageSendButton:
    'button.msg-form__send-button, button[aria-label="Send"], button:has-text("Send")',
  messageOverlay: '.msg-overlay-conversation-bubble, .msg-overlay-list-bubble',

  // ── Dialogs ───────────────────────────────────────────────────────────────────
  modalClose: 'button[aria-label="Dismiss"], button[aria-label="Close"]',
} as const;

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
