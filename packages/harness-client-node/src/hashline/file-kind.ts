const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg"]);
const BINARY_EXTENSIONS = new Set([".pdf", ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat"]);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function isBinaryFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return BINARY_EXTENSIONS.has(ext) || isImageFile(filePath);
}
