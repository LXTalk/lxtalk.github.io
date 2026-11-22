// anon/publishable key は公開されても問題ない設計(権限はRLSで制御)です。
// service_role / secret キーは絶対にここへ書かないでください。
export const SUPABASE_URL = 'https://ljckdahozgxinpadfvdb.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_4YO4Q26vI8AEh8PZyG8Ouw_oaVrnmOS';

// 認証コード再送のクールダウン(秒)。Supabase側の送信間隔設定以上にしてください
export const RESEND_COOLDOWN_SEC = 60;

// Web Push の公開鍵(VAPID公開鍵)。tools/vapid.html で作成した「公開鍵」だけを入れる。
// 空のままなら通知機能は表示されません。秘密鍵は絶対にここへ書かないでください。
export const VAPID_PUBLIC_KEY = '';
