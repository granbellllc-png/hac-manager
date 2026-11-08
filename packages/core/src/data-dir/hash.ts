export async function hashContent(
  content: string | Uint8Array,
): Promise<string> {
  const data =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    data as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeDataDirVersionHash(
  fileHashes: Readonly<Record<string, string>>,
): Promise<string> {
  const sortedEntries = Object.entries(fileHashes).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const payload = sortedEntries
    .map(([path, hash]) => `${path}:${hash}`)
    .join('\n');
  return hashContent(payload);
}
