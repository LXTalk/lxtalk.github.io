// LXTalk Service Worker: ①アプリ本体のキャッシュ(オフラインでも画面を開ける) ②Web Push
// 個人データ(メッセージ・ファイル・認証・API応答)は一切キャッシュしない。
const CACHE = 'lxtalk-shell-v8';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/config.js', 'js/validate.js', 'js/home.js', 'js/chat.js', 'js/push.js', 'js/filetype.js', 'js/uuid.js', 'js/format.js', 'js/group.js', 'js/avatar.js', 'js/share.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
// 外部で読み込む公開ライブラリ(認証・データには無関係)だけは例外的にキャッシュする
const LIB_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 1つ失敗しても全体を止めない(次回の通信時に補う)
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lxtalk-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function cacheable(url) {
  if (url.origin === self.location.origin) return true;
  return url.hostname === LIB_HOST;
}

// ---------- 他のアプリからの共有(Web Share Target) ----------
// 共有された内容は、送信先を選ぶ画面が読み取るまでの間だけ share-inbox に置く(読み取り後すぐ削除。10分で失効)
// ※キャッシュ名は 'lxtalk-' で始めない(activate の古いキャッシュ削除の対象にしないため)
const INBOX = 'share-inbox';
async function handleShare(req) {
  const back = (q) => Response.redirect(new URL('./' + q, self.registration.scope).href, 303);
  try {
    const f = await req.formData();
    const parts = ['title', 'text', 'url'].map((k) => String(f.get(k) || '').trim()).filter(Boolean);
    const text = [...new Set(parts)].filter((p, i, a) => !a.some((o, j) => j !== i && o.length > p.length && o.includes(p))).join('\n').slice(0, 4000);
    const files = f.getAll('files').filter((x) => x && typeof x === 'object' && 'size' in x && x.size > 0).slice(0, 10);
    if (!text && files.length === 0) return back('');
    await caches.delete(INBOX);
    const c = await caches.open(INBOX);
    const meta = { at: Date.now(), text, files: files.map((x, i) => ({ i, name: x.name || 'file', type: x.type || 'application/octet-stream' })) };
    await c.put('/share-inbox/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
    for (const m of meta.files) await c.put('/share-inbox/f/' + m.i, new Response(files[m.i], { headers: { 'content-type': m.type } }));
    return back('?share=1');
  } catch { return back(''); }
}

// ネットワーク優先(常に最新を取得)→ 失敗(オフライン)したらキャッシュ
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST') {
    const u = new URL(req.url);
    if (u.origin === self.location.origin && u.pathname.endsWith('/share-target')) e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;                       // Supabase・Pushサービス等には関与しない
  if (url.origin === self.location.origin && url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await c.match('index.html') || await c.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

// ---------- Web Push ----------
// 通知から開く先は、同じオリジン内のURLだけを許可する
function safeUrl(u) {
  try {
    const x = new URL(String(u || ''), self.registration.scope);
    if (x.origin !== self.location.origin) return self.registration.scope;
    return x.href;
  } catch { return self.registration.scope; }
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 60) : 'LXTalk';
  const body = typeof d.body === 'string' ? d.body.slice(0, 120) : '';
  const tag = typeof d.tag === 'string' && d.tag ? d.tag.slice(0, 80) : undefined;
  event.waitUntil((async () => {
    // アプリを見ている最中は、画面側で反映されるため通知は出さない
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    await self.registration.showNotification(title, {
      body, tag, renotify: !!tag,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      data: { url: safeUrl(d.url) },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = list[0];
    if (c) {
      try { await c.focus(); } catch { /* 無視 */ }
      c.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
