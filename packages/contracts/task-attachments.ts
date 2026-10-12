/** Host-snapshotted user material. Its contents never grant task authority. */
export interface TaskAttachment {
  name: string; path: string; size: number; sha256: string;
  kind: 'text' | 'image' | 'video' | 'file';
}
export function validateTaskAttachments(value: unknown): asserts value is TaskAttachment[] {
  if (!Array.isArray(value) || value.length > 10) throw Error('每条消息最多添加 10 个附件');
  const paths = new Set<string>();
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'kind,name,path,sha256,size'
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\x00-\x1f/\\]/.test(item.name)
      || typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.length > 4096 || item.path.includes('\0')
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 64 * 1024 * 1024
      || !['text', 'image', 'video', 'file'].includes(item.kind) || paths.has(item.path)) throw Error('附件记录无效或超过单文件 64 MB 限制');
    paths.add(item.path); total += item.size;
  }
  if (total > 256 * 1024 * 1024) throw Error('每条消息附件总大小不能超过 256 MB');
}
