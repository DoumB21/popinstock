import { SessionKit } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';
import { WalletPluginWombat } from '@wharfkit/wallet-plugin-wombat';

const WAX_CHAIN = {
  id: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
  url: 'https://wax.greymass.com',
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

export async function transact(actions) {
  if (!session) throw new Error('Not logged in');
  return session.transact({ actions });
}
