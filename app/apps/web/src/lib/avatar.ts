// The profile picture is a client preference, like the theme: kept in this browser, never sent to the
// server. It's cropped to a centred square and scaled down first, so it stays a few KB in storage.

const SIZE = 160; // px: sharp at the 48px Settings preview on a 3x screen
const MAX_BYTES = 20 * 1024 * 1024;

function load(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image couldn’t be read. Try a PNG or JPEG.'));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** A picture file as a square JPEG data: URL, ready to store as the avatar. */
export async function avatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file isn’t an image. Pick a PNG, JPEG or other picture.');
  if (file.size > MAX_BYTES) throw new Error('That picture is over 20 MB. Pick a smaller one.');
  const img = await load(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error('That image couldn’t be read. Try a PNG or JPEG.');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
  return canvas.toDataURL('image/jpeg', 0.88);
}
