/**
 * Centralized Instagram web UI selectors.
 * Update this file when Instagram changes visible markup.
 *
 * All automation must target visible UI only — no private/internal API endpoints.
 */
export const SELECTORS = {
  /** Login / session */
  loginForm: 'form#loginForm, input[name="username"], input[aria-label="Phone number, username, or email"]',
  homeFeedHint: 'svg[aria-label="Home"], a[href="/"]',

  /** Security / challenge surfaces — stop immediately if seen */
  security: {
    captchaIframe: 'iframe[src*="captcha"], iframe[title*="captcha" i], iframe[src*="recaptcha"]',
    challengeText: 'text=/suspicious|confirm it.?s you|security (code|check)|unusual activity|try again later|we suspended|account.*disabled|challenge_required|confirm your identity/i',
    checkpointUrlPart: '/challenge/',
    accountsSuspended: 'text=/suspended|disabled your account|temporarily locked/i',
  },

  /** Search */
  searchNav: 'a[href="/explore/"], svg[aria-label="Search"], a[href="#"][role="link"]:has(svg[aria-label="Search"])',
  searchInput:
    'input[placeholder="Search"], input[aria-label="Search input"], input[type="text"][placeholder*="Search" i]',
  searchResultLinks: 'a[href^="/"][role="link"], a[href*="/"]',

  /** Profile */
  profileHeader: 'header section, main header, header',
  displayedName:
    'header section span, header h2, header h1, main header span, section > div > div > span',
  verifiedBadge: 'svg[aria-label="Verified"], [aria-label="Verified"], title:has-text("Verified")',
  privateAccountText: 'text=/This account is private|This Account is Private/i',
  bioBlock: 'header section > div, header section span, -webkit-box',
  messageButtonCandidates: [
    'div[role="button"]:has-text("Message")',
    'button:has-text("Message")',
    'a:has-text("Message")',
    '[role="button"][tabindex="0"]:has-text("Message")',
  ],
  followButton: 'button:has-text("Follow"), div[role="button"]:has-text("Follow")',
  followingButton: 'button:has-text("Following"), div[role="button"]:has-text("Following")',

  /** Messaging composer */
  messageComposer:
    'div[aria-label="Message"], textarea[placeholder*="Message" i], div[role="textbox"][contenteditable="true"], textarea[aria-label*="Message" i]',
  sendButtonCandidates: [
    'div[role="button"]:has-text("Send")',
    'button:has-text("Send")',
    '[aria-label="Send"]',
  ],

  /** Dialogs that can block interaction */
  notNowButton:
    'button:has-text("Not Now"), div[role="button"]:has-text("Not Now"), [role="button"]:has-text("Not Now")',
  dismissButton:
    'button:has-text("Dismiss"), svg[aria-label="Close"], [aria-label="Close"], [aria-label="Close sidebar"]',
  notificationDialog:
    'text=/Turn on Notifications|Enable notifications|Get notifications/i',
} as const;

export const INSTAGRAM_ORIGIN = 'https://www.instagram.com';
