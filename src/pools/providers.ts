/**
 * Subscription account pools: which agent CLIs can keep several sign-ins side by side, each in its own CLI home inside
 * the plugin's data folder, and how. Pure table; checked against the CLIs' own documentation (account-pools-spec.md §2).
 *
 * Every CLI here signs in with OAuth whose refresh token rotates and is single-use, so one home is used by one running
 * card at a time (`perHome: 'one'`): two processes refreshing the same sign-in at once log each other out (Claude Code
 * anthropics/claude-code#54443, Codex `refresh_token_reused`, Kimi 1.38.0 release note). The same reason keeps every
 * home on this computer: a sign-in is never copied anywhere.
 */

export const POOL_PROVIDERS = ['claude', 'codex', 'grok', 'kimi'] as const;
export type PoolProvider = typeof POOL_PROVIDERS[number];

export interface PoolProviderInfo {
  label: string;
  /** The variable that moves the CLI's whole home, sign-in included. */
  homeVariable: string;
  /** Extra variables for every run in the home (blank ones keep a person's shell from overriding the sign-in). */
  env: Readonly<Record<string, string>>;
  /** Files whose existence (never contents) says the home holds a sign-in. */
  credentialFiles: readonly string[];
  /** A folder whose non-empty listing (names only) says the same. */
  credentialFolder?: string;
  /** CanvasTTY reads this provider's limits for an account home (`limits.get {provider, home}`). */
  limits: boolean;
  /** CanvasTTY's own limits read may refresh the sign-in (Codex starts its app-server): never while a card runs there. */
  limitsReadRefreshes: boolean;
  perHome: 'one';
  /** What the person does in the sign-in card. */
  signIn: { en: string; ru: string };
}

export const POOL_INFO: Readonly<Record<PoolProvider, PoolProviderInfo>> = Object.freeze({
  claude: {
    label: 'Claude Code', homeVariable: 'CLAUDE_CONFIG_DIR', env: {},
    // Linux and Windows (and a macOS Keychain fallback); on macOS the sign-in is a Keychain entry keyed to the folder,
    // so the core's limits read (or Claude's own .claude.json account marker) tells.
    credentialFiles: ['.credentials.json'], limits: true, limitsReadRefreshes: false, perHome: 'one',
    signIn: { en: 'Claude Code starts its first-run setup: choose a theme, then sign in with your Claude account in the browser (or type /login).', ru: 'Claude Code начнёт первую настройку: выберите тему и войдите своей учётной записью Claude в браузере (или наберите /login).' }
  },
  codex: {
    label: 'Codex', homeVariable: 'CODEX_HOME', env: { CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' },
    credentialFiles: ['auth.json'], limits: true, limitsReadRefreshes: true, perHome: 'one',
    signIn: { en: 'Codex shows its sign-in screen: choose "Sign in with ChatGPT" and finish in the browser.', ru: 'Codex покажет экран входа: выберите «Sign in with ChatGPT» и завершите вход в браузере.' }
  },
  grok: {
    label: 'Grok', homeVariable: 'GROK_HOME', env: {},
    credentialFiles: ['auth.json'], limits: true, limitsReadRefreshes: false, perHome: 'one',
    signIn: { en: 'Grok opens the browser to sign in at grok.com (password or Google).', ru: 'Grok откроет браузер для входа на grok.com (пароль или Google).' }
  },
  kimi: {
    label: 'Kimi', homeVariable: 'KIMI_CODE_HOME', env: {},
    // CanvasTTY reads a Kimi home through one `kimi web` started there, which may refresh the sign-in.
    credentialFiles: [], credentialFolder: 'credentials', limits: true, limitsReadRefreshes: true, perHome: 'one',
    signIn: { en: 'Type /login in Kimi and choose Kimi Code (OAuth); finish in the browser.', ru: 'Наберите /login в Kimi и выберите Kimi Code (OAuth); завершите вход в браузере.' }
  }
});

/** Agents that cannot have a pool here, and why (shown to the person and to orchestrators). */
export const NOT_POOLED: Readonly<Record<string, string>> = Object.freeze({
  qwen: 'Qwen Code has no variable that moves its home (its sign-in is always ~/.qwen), and the Qwen OAuth free tier closed on 2026-04-15.',
  opencode: 'OpenCode Go signs in with an API key, not a browser sign-in: add it as a model account with its key.'
});

export const isPoolProvider = (value: unknown): value is PoolProvider => typeof value === 'string' && (POOL_PROVIDERS as readonly string[]).includes(value);
