import * as path from 'path';

// 文件类型映射（从 tools.ts 抽取的公共逻辑）
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.amr'];
const FILE_TYPE_MAP: Record<string, string> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.mp4': 'mp4',
};

export type FileCategory = 'image' | 'audio' | 'file';

export function getFileCategory(filePath: string): FileCategory {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return 'file';
}

export function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return FILE_TYPE_MAP[ext] || 'stream';
}
