'use strict';

// Shared Telegram sign-in for Fun Central mini apps (Bridge keeps its own copy in app.js).
// Same storage key as Bridge, so signing in once works across every app on this origin.
window.FunAuth = (() => {
  const KEY = 'authToken';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* blocked */ } };
  const isLocal = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  /** Verified profile for the saved token, or null. A transient outage keeps the token. */
  async function profile() {
    const token = read();
    if (!token) return null;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ...(await res.json()), token };
      if ([401, 403, 404].includes(res.status)) write(null);
      return null;
    } catch {
      return { token, displayName: null, offline: true };
    }
  }

  async function finish(res, onLogin) {
    if (!res.ok) throw new Error('Sign-in failed');
    const data = await res.json();
    if (typeof data.token !== 'string' || !data.token) throw new Error('Sign-in failed');
    write(data.token);
    onLogin({ ...data });
  }

  /** Renders the Telegram widget (and the localhost dev login) into `container`. */
  async function mountLogin(container, onLogin) {
    window.onTelegramAuth = async (user) => {
      try {
        await finish(await fetch('/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) }), onLogin);
      } catch { alert('Telegram login failed. Please try again.'); }
    };
    const widget = container.querySelector('[data-telegram]');
    if (widget && !widget.hasChildNodes()) {
      try {
        const { botUsername } = await (await fetch('/api/config')).json();
        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://telegram.org/js/telegram-widget.js?22';
        script.setAttribute('data-telegram-login', botUsername);
        script.setAttribute('data-size', 'large');
        script.setAttribute('data-onauth', 'onTelegramAuth(user)');
        script.setAttribute('data-request-access', 'write');
        widget.appendChild(script);
      } catch { /* config unavailable */ }
    }
    const dev = container.querySelector('[data-dev-login]');
    if (!dev) return;
    dev.classList.toggle('hidden', !isLocal());
    const btn = dev.querySelector('button');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const displayName = dev.querySelector('input').value.trim() || 'Dev User';
        try {
          await finish(await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) }), onLogin);
        } catch { alert('Dev login failed — is the server running with ALLOW_DEV_LOGIN=1?'); }
      });
    }
  }

  return { token: read, profile, mountLogin, logout: () => write(null) };
})();
