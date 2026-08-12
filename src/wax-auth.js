import { SessionKit } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';
import { WalletPluginWombat } from '@wharfkit/wallet-plugin-wombat';

const DEFAULT_RPC = 'https://wax.greymass.com';

const WAX_CHAIN = {
  id: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
  // 'hoardio_rpc_endpoint' is set by shared/settings.js (edited on profile.html)
  // — read directly here (same key, no import) since this file compiles to a
  // standalone bundle. Empty/unset falls back to the default above.
  url: localStorage.getItem('hoardio_rpc_endpoint') || DEFAULT_RPC,
};

const ui = new WebRenderer();

const sessionKit = new SessionKit({
  appName: 'Hoardio',
  chains: [WAX_CHAIN],
  ui,
  walletPlugins: [
    new WalletPluginCloudWallet(),
    new WalletPluginAnchor(),
    new WalletPluginWombat(),
  ],
});

let session = null;

// Lets a visitor change the RPC endpoint on profile.html in one tab and have
// it take effect immediately in another already-open tab's live session —
// e.g. mid-search on explore.html, without losing filter state to a reload.
// 'storage' only fires in OTHER tabs, never the one that made the change.
window.addEventListener('storage', e => {
  if (e.key === 'hoardio_rpc_endpoint' && session) {
    session.setEndpoint(e.newValue || DEFAULT_RPC);
  }
});

function _dispatch(account) {
  if (account) {
    localStorage.setItem('wax_account', account);
  } else {
    localStorage.removeItem('wax_account');
  }
  window.dispatchEvent(new CustomEvent('wax-auth-change', { detail: { account } }));
}

export function login() {
  return new Promise((resolve, reject) => {
    let settled = false;

    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    // The WharfKit modal is a native <dialog> inside the shadow DOM.
    // When the user closes it (X button, backdrop, Escape), dialog.close() is called
    // and a 'close' event fires. We use this as the cancellation signal.
    // A small delay lets the success path's .then() settle first before we reject.
    const dialog = ui.shadow?.querySelector('dialog');
    const onClose = () => setTimeout(() => done(reject, new Error('cancelled')), 50);
    if (dialog) dialog.addEventListener('close', onClose, { once: true });

    sessionKit.login()
      .then(result => {
        if (dialog) dialog.removeEventListener('close', onClose);
        session = result.session;
        const account = String(session.actor);
        _dispatch(account);
        done(resolve, account);
      })
      .catch(err => {
        if (dialog) dialog.removeEventListener('close', onClose);
        session = null;
        done(reject, err);
      });
  });
}

export async function logout() {
  await sessionKit.logout(session);
  session = null;
  _dispatch(null);
}

export async function restore() {
  try {
    const restored = await sessionKit.restore();
    if (restored) {
      session = restored;
      const account = String(session.actor);
      localStorage.setItem('wax_account', account);
      return account;
    }
  } catch { /* no saved session */ }
  return null;
}

export function getAccount() {
  if (session) return String(session.actor);
  return localStorage.getItem('wax_account') || null;
}

export async function getLinkedAccounts() {
  const sessions = await sessionKit.getSessions(); // SerializedSession[]
  const activeActor = session ? String(session.actor) : null;
  const activePermission = session ? String(session.permission) : null;
  return sessions.map(s => ({
    actor: String(s.actor),
    permission: String(s.permission),
    isActive: String(s.actor) === activeActor && String(s.permission) === activePermission,
  }));
}

export async function switchTo(actor, permission) {
  const restored = await sessionKit.restore(
    { chain: WAX_CHAIN.id, actor, permission },
    { setAsDefault: true }
  );
  if (!restored) throw new Error('Wallet not found — it may have been unlinked.');
  session = restored;
  _dispatch(String(session.actor));
  return String(session.actor);
}

export async function unlink(actor, permission) {
  const activeActor = session ? String(session.actor) : null;
  const activePermission = session ? String(session.permission) : null;
  if (actor === activeActor && permission === activePermission) {
    throw new Error('Cannot unlink the active wallet — switch to another one first.');
  }

  const sessions = await sessionKit.getSessions();
  const target = sessions.find(s => String(s.actor) === actor && String(s.permission) === permission);
  if (!target) return; // already gone

  // sessionKit.logout(session) unconditionally clears the singular 'session'
  // storage pointer first, regardless of which session is targeted, even
  // though the still-active session is otherwise untouched — repair it below.
  await sessionKit.logout(target);

  if (session) {
    const restored = await sessionKit.restore(
      { chain: WAX_CHAIN.id, actor: String(session.actor), permission: String(session.permission) },
      { setAsDefault: true }
    );
    if (restored) session = restored;
  }
  // No _dispatch() here — the active account didn't change.
}

export async function transact(actions) {
  if (!session) throw new Error('Not logged in');
  return session.transact({ actions });
}
