// 入力検証(UI用。最終的な検証は必ずサーバー側=DB制約でも行われる)

export const USER_ID_RE = /^[a-z0-9_]{3,20}$/;

export function normalizeUserId(v) {
  return String(v ?? '').trim().toLowerCase();
}

export function validateUserId(v) {
  const id = normalizeUserId(v);
  if (!USER_ID_RE.test(id)) {
    return 'ユーザーIDは半角英数字とアンダースコアで3〜20文字にしてください';
  }
  return null;
}

export function validateDisplayName(v) {
  const s = String(v ?? '').trim();
  if (s.length < 1 || s.length > 30) return '表示名は1〜30文字にしてください';
  return null;
}

export function validateEmail(v) {
  const s = String(v ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'メールアドレスの形式が正しくありません';
  return null;
}

export function validatePassword(v) {
  const s = String(v ?? '');
  if (s.length < 8) return 'パスワードは8文字以上にしてください';
  if (s.length > 72) return 'パスワードは72文字以内にしてください';
  return null;
}

export function validateOtp(v) {
  if (!/^\d{6}$/.test(String(v ?? '').trim())) return '6桁の数字を入力してください';
  return null;
}

// 認証コードの連続入力制限(クライアント側の補助。本体はSupabase Authのレート制限)
export function createAttemptLimiter({ max = 5, lockMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let fails = 0;
  let lockedUntil = 0;
  return {
    remainingLockMs() {
      return Math.max(0, lockedUntil - now());
    },
    isLocked() {
      return now() < lockedUntil;
    },
    fail() {
      fails += 1;
      if (fails >= max) {
        lockedUntil = now() + lockMs;
        fails = 0;
      }
    },
    success() {
      fails = 0;
      lockedUntil = 0;
    },
  };
}
