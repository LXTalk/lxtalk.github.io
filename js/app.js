import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, RESEND_COOLDOWN_SEC, VAPID_PUBLIC_KEY } from './config.js';
import {
  normalizeUserId, validateUserId, validateDisplayName, validateEmail,
  validatePassword, validateOtp, createAttemptLimiter,
} from './validate.js';
import { createHome } from './home.js';
import { createChat } from './chat.js';
import { createPush } from './push.js';

const $ = (sel, root = document) => root.querySelector(sel);
const views = ['loading', 'offline', 'login', 'signup', 'verify', 'home', 'chat'];

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const push = supabase && VAPID_PUBLIC_KEY ? createPush({ supabase, vapidKey: VAPID_PUBLIC_KEY }) : null;
const chat = supabase ? createChat({ supabase, toast, onClose: () => show('home') }) : null;
const home = supabase ? createHome({
  supabase, toast,
  push,
  onLogout: async () => { if (push) await push.disable(); chat.close(); home.unmount(); await supabase.auth.signOut(); show('login'); },
  onOpenChat: (friend, me) => { chat.open(friend, me); show('chat'); },
}) : null;

let pendingEmail = '';
const otpLimiter = createAttemptLimiter({ max: 5, lockMs: 5 * 60 * 1000 });
let resendTimer = null;

// ---------- UI helpers ----------
function show(name) {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
}

function setError(form, msg) {
  $('.error', form).textContent = msg || '';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function withBusy(form, fn) {
  const btn = $('button[type="submit"]', form);
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

function startResendCooldown() {
  const btn = $('#btn-resend');
  let left = RESEND_COOLDOWN_SEC;
  clearInterval(resendTimer);
  btn.disabled = true;
  btn.textContent = `コードを再送信する(${left}秒)`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = 'コードを再送信する';
    } else {
      btn.textContent = `コードを再送信する(${left}秒)`;
    }
  }, 1000);
}

function goVerify(email) {
  pendingEmail = email;
  $('#verify-email').textContent = email;
  setError($('#form-verify'), '');
  $('#form-verify').reset();
  show('verify');
}

// ---------- 画面遷移 ----------
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});

// ---------- 登録 ----------
$('#form-signup').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const f = new FormData(form);
  const email = String(f.get('email')).trim();
  const user_id = normalizeUserId(f.get('user_id'));
  const display_name = String(f.get('display_name')).trim();
  const password = String(f.get('password'));

  const err = validateEmail(email) || validateUserId(user_id)
    || validateDisplayName(display_name) || validatePassword(password);
  if (err) return setError(form, err);
  if (!supabase) return setError(form, 'Supabaseの接続設定(js/config.js)が未設定です');

  setError(form, '');
  withBusy(form, async () => {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { user_id, display_name } },
    });
    if (error) {
      // ユーザーID重複・形式不正はDBトリガーで失敗する
      const m = String(error.message || '').toLowerCase();
      if (m.includes('database error') || error.status === 500) {
        return setError(form, 'このユーザーIDは使用できません。別のIDをお試しください');
      }
      if (error.status === 429) return setError(form, '操作が多すぎます。しばらくしてからお試しください');
      return setError(form, '登録できませんでした。入力内容を確認してください');
    }
    if (data.session) {
      // メール確認が無効なSupabase設定。認証前にチャットを使わせない
      await supabase.auth.signOut();
      return setError(form, '設定エラー: メール確認が有効になっていません');
    }
    goVerify(email);
    startResendCooldown();
  });
});

// ---------- 6桁コード認証 ----------
$('#form-verify').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const code = String(new FormData(form).get('code')).trim();

  if (otpLimiter.isLocked()) {
    const min = Math.ceil(otpLimiter.remainingLockMs() / 60000);
    return setError(form, `入力に失敗しすぎました。約${min}分後にお試しください`);
  }
  const err = validateOtp(code);
  if (err) return setError(form, err);
  if (!supabase) return setError(form, 'Supabaseの接続設定が未設定です');

  setError(form, '');
  withBusy(form, async () => {
    const { error } = await supabase.auth.verifyOtp({ email: pendingEmail, token: code, type: 'signup' });
    if (error) {
      if (error.status === 429) return setError(form, '操作が多すぎます。しばらくしてからお試しください');
      otpLimiter.fail();
      return setError(form, '認証コードが正しくないか、有効期限が切れています');
    }
    otpLimiter.success();
    await enterHome();
  });
});

$('#btn-resend').addEventListener('click', async () => {
  if (!supabase || !pendingEmail) return;
  const form = $('#form-verify');
  setError(form, '');
  startResendCooldown(); // 連打防止のため先にロック
  const { error } = await supabase.auth.resend({ type: 'signup', email: pendingEmail });
  if (error) {
    setError(form, error.status === 429
      ? '再送信の回数が上限に達しました。しばらくしてからお試しください'
      : '再送信できませんでした');
  } else {
    toast('認証コードを再送信しました');
  }
});

// ---------- ログイン / ログアウト ----------
$('#form-login').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const f = new FormData(form);
  const email = String(f.get('email')).trim();
  const password = String(f.get('password'));
  if (validateEmail(email) || !password) return setError(form, 'メールアドレスとパスワードを入力してください');
  if (!supabase) return setError(form, 'Supabaseの接続設定(js/config.js)が未設定です');

  setError(form, '');
  withBusy(form, async () => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === 'email_not_confirmed') {
        goVerify(email); // 未認証。再送信ボタンから新しいコードを請求できる
        return setError($('#form-verify'), 'メール認証が完了していません。コードを入力してください');
      }
      if (error.status === 429) return setError(form, '操作が多すぎます。しばらくしてからお試しください');
      return setError(form, 'メールアドレスまたはパスワードが正しくありません');
    }
    form.reset();
    await enterHome(data.session);
  });
});


// ---------- ホーム ----------
async function enterHome() {
  // 通信できない時は、ログアウトせずに「接続できません」を表示する(セッションは端末に残る)
  let session;
  try {
    const r = await supabase.auth.getSession();
    session = r.data.session;
  } catch { return show('offline'); }
  const user = session && session.user;
  if (!user || !user.email_confirmed_at) {
    // 認証完了前はチャット機能に入れない(権限の本体はサーバー側のRLS)
    await supabase.auth.signOut();
    return show('login');
  }
  const { data: profile, error } = await supabase
    .from('profiles').select('id, user_id, display_name, avatar_path').eq('id', user.id).maybeSingle();
  if (error && !profile) return show('offline');
  if (!profile) {
    await supabase.auth.signOut();
    show('login');
    return setError($('#form-login'), 'プロフィールを取得できませんでした');
  }
  home.mount(profile);
  show('home');
  if (push) push.sync();
  await handleOpen(takePendingOpen());
}

// ---------- 通知タップ(?open=...)の処理 ----------
// 通知のURLは「?open=chat&c=<16桁>」「?open=requests」「?open=friends」だけを受け付ける
let pendingOpen = null;
function parseOpen(u) {
  try {
    const q = new URL(u, location.href).searchParams;
    const o = q.get('open');
    if (o === 'requests' || o === 'friends') return { open: o };
    if (o === 'chat' && /^\d{16}$/.test(q.get('c') || '')) return { open: 'chat', c: q.get('c') };
  } catch { /* 無視 */ }
  return null;
}
function takePendingOpen() { const p = pendingOpen; pendingOpen = null; return p; }
async function handleOpen(t) {
  if (!t || !home || !home.getMe()) return;
  if (t.open === 'chat') {
    const f = await home.friendByConv(t.c);
    if (f) { chat.open(f, home.getMe()); show('chat'); }
    return;
  }
  chat.close();
  show('home');
  home.goTab(t.open);
}
function receiveOpen(u) {
  const t = parseOpen(u);
  if (!t) return;
  if (home && home.getMe()) handleOpen(t); else pendingOpen = t; // 未ログインならログイン後に開く
}
if (location.search.includes('open=')) {
  pendingOpen = parseOpen(location.href);
  history.replaceState(null, '', location.pathname); // URLに情報を残さない
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open') receiveOpen(e.data.url);
  });
}

// ---------- オフライン表示 / インストール ----------
function syncOnline() { $('#offline-bar').hidden = navigator.onLine; }
window.addEventListener('offline', syncOnline);
window.addEventListener('online', () => {
  syncOnline();
  if (!$('#view-offline').hidden && supabase) enterHome();   // 接続が戻ったら自動で再開
});
syncOnline();
$('#btn-retry').addEventListener('click', () => { if (supabase) enterHome(); });

let installEvt = null;
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
function renderInstall() {
  const box = $('#install-box');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (standalone()) { box.hidden = true; return; }
  box.hidden = !(installEvt || ios);
  $('#btn-install').hidden = !installEvt;
  $('#install-text').textContent = installEvt
    ? 'ホーム画面に追加すると、アプリのように起動できます。'
    : 'Safariの共有ボタンから「ホーム画面に追加」すると、アプリのように起動できます。';
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); });
$('#btn-install').addEventListener('click', async () => {
  if (!installEvt) return;
  const e = installEvt; installEvt = null; renderInstall();
  e.prompt();
  try { await e.userChoice; } catch { /* 無視 */ }
});
renderInstall();
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

// ---------- 起動 ----------
(async function init() {
  if (!supabase) {
    show('login');
    setError($('#form-login'), 'Supabaseの接続設定(js/config.js)が未設定です');
    return;
  }
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { chat.close(); home.unmount(); show('login'); }
  });
  let session = null;
  try { session = (await supabase.auth.getSession()).data.session; } catch { /* 通信不可 */ }
  if (session) await enterHome();
  else show(navigator.onLine ? 'login' : 'offline');
})();
