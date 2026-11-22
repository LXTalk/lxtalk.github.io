// ファイルの形式は「拡張子」から判断する(中身は調べない)。表示と、画像/動画/音声のプレビュー判定に使う。
// 種類による送信制限はなく、容量のみ制限する。

export const UNKNOWN_LABEL = 'ファイル';

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'ico']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', '3gp', 'mpg', 'mpeg']);
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac', 'weba', 'amr']);

export function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return '';   // 拡張子なし・「.gitignore」のような先頭ドットのみは対象外
  const e = s.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(e) ? e : '';
}

// 表示用の形式名(例: report.xlsx → "XLSX")
export function labelFromName(name) {
  const e = extOf(name);
  return e ? e.toUpperCase() : UNKNOWN_LABEL;
}

// 'image' | 'video' | 'audio' | null
export function mediaKind(name) {
  const e = extOf(name);
  if (IMAGE.has(e)) return 'image';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  return null;
}

export function describeFile(label) {
  return label === UNKNOWN_LABEL ? 'ファイルが送信されました' : `${label}形式のファイルが送信されました`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
