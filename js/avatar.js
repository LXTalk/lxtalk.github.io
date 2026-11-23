// アイコン画像の共通処理(プロフィール・グループ共通)
// 画像は端末側で正方形に切り抜き・256px に再エンコードしてから送る
// (サーバー側でも 2MB・JPEG/PNG/WebP のみに制限している)
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;   // 選べる元画像の上限(縮小して保存するので、保存される画像は小さい)
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function toAvatarBlob(file) {
  const bmp = await createImageBitmap(file);
  const size = 256;
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(
    bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  const webp = await toBlob('image/webp', 0.85);
  if (webp && webp.type === 'image/webp') return { blob: webp, ext: 'webp' };
  const jpg = await toBlob('image/jpeg', 0.88);
  return { blob: jpg, ext: 'jpg' };
}
