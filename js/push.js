// Web Push の購読管理。通知を受け取るかは端末ごとにユーザーが選ぶ
const b64ToBytes = (s) => {
  const p = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const toB64Url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPush({ supabase, vapidKey }) {
  const supported = () => !!vapidKey && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  let regPromise = null;
  function register() {
    if (!regPromise) regPromise = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready);
    return regPromise;
  }

  // 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'
  async function state() {
    if (!supported()) return isIos() && !isStandalone() && vapidKey ? 'needs-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      const reg = await register();
      const sub = await reg.pushManager.getSubscription();
      return sub && Notification.permission === 'granted' ? 'on' : 'off';
    } catch { return 'unsupported'; }
  }

  async function enable() {
    if (!supported()) return 'unsupported';
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
    const reg = await register();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidKey) });
    const j = sub.toJSON();
    const p256dh = j.keys?.p256dh || toB64Url(sub.getKey('p256dh'));
    const auth = j.keys?.auth || toB64Url(sub.getKey('auth'));
    const { data, error } = await supabase.rpc('save_push_subscription', {
      p_endpoint: sub.endpoint, p_p256dh: p256dh, p_auth: auth, p_user_agent: navigator.userAgent.slice(0, 300),
    });
    if (error || data !== true) { try { await sub.unsubscribe(); } catch { /* 無視 */ } throw new Error('save_failed'); }
    return 'on';
  }

  // 解除: サーバー側の購読 → ブラウザ側の購読 の順に消す(ログアウト時にも使う)
  async function disable() {
    if (!supported()) return;
    try {
      const reg = await register();
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    } catch { /* ログアウトを妨げない */ }
  }

  // ログイン済みで許可済みなら、購読をこのユーザーに紐付け直す(端末を共有した場合など)
  async function sync() {
    if (!supported() || Notification.permission !== 'granted') return;
    try { if ((await state()) === 'on') await enable(); } catch { /* 無視 */ }
  }

  return { supported, state, enable, disable, sync, register, isIos, isStandalone };
}
