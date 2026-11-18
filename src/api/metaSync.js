/**
 * Conflict-Free Shared Metadata Sync on Google Drive (.drivelens/)
 * - tags-schema.json: Shared tag definitions merged per-tag by latest updatedAt
 * - member-<key>.json: Each member writes ONLY to their own JSON file
 */
import { t } from '../i18n.js';
import { fetchWithDriveBackoff } from './gdrive.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const META_FOLDER_NAME = '.drivelens';
export const TAGS_SCHEMA_FILENAME = 'tags-schema.json';

export function sanitizeMemberKey(memberId) {
  const raw = String(memberId || 'member').trim().toLowerCase();
  const clean = raw.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  const suffix = Math.abs(hash).toString(36).slice(0, 5);
  return `${clean.slice(0, 42) || 'user'}_${suffix}`;
}

async function fetchJsonMedia(fileId, accessToken) {
  const resp = await fetchWithDriveBackoff(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) {
    throw new Error(t('metaSync.readMetaFailed', { status: resp.status }));
  }
  return resp.json();
}

async function findChildByName(parentId, name, mimeType, accessToken) {
  const safeName = name.replace(/'/g, "\\'");
  let q = `'${parentId}' in parents and name = '${safeName}' and trashed = false`;
  if (mimeType) {
    q += ` and mimeType = '${mimeType}'`;
  }
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType)',
    pageSize: '5',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const resp = await fetchWithDriveBackoff(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(t('metaSync.queryFolderFailed', { status: resp.status }));
  }
  const data = await resp.json();
  return data.files?.[0] || null;
}

export async function ensureMetaFolder(rootFolderId, accessToken) {
  const existing = await findChildByName(
    rootFolderId,
    META_FOLDER_NAME,
    'application/vnd.google-apps.folder',
    accessToken
  );
  if (existing) return existing.id;

  const resp = await fetchWithDriveBackoff(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: META_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    }),
  });
  if (!resp.ok) {
    throw new Error(t('metaSync.createFolderFailed', { status: resp.status }));
  }
  const created = await resp.json();
  return created.id;
}

async function createJsonFile(parentId, name, dataObj, accessToken) {
  const boundary = `drivelens_meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metadata = JSON.stringify({
    name,
    mimeType: 'application/json',
    parents: [parentId],
  });
  const content = JSON.stringify(dataObj, null, 2);

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const resp = await fetchWithDriveBackoff(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!resp.ok) {
    throw new Error(t('metaSync.createFileFailed', { status: resp.status }));
  }
  const created = await resp.json();
  return created.id;
}

async function updateJsonFile(fileId, dataObj, accessToken) {
  const resp = await fetchWithDriveBackoff(
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(dataObj, null, 2),
    }
  );
  if (!resp.ok) {
    throw new Error(t('metaSync.updateFileFailed', { status: resp.status }));
  }
  return fileId;
}

export function mergeTagSchemas(localSchema, remoteSchema) {
  const mergedTags = {};
  const remoteTags = remoteSchema?.tags || {};
  const localTags = localSchema?.tags || {};
  const allIds = new Set([...Object.keys(remoteTags), ...Object.keys(localTags)]);

  for (const id of allIds) {
    const r = remoteTags[id];
    const l = localTags[id];
    if (r && l) {
      mergedTags[id] = Number(l.updatedAt || 0) >= Number(r.updatedAt || 0) ? l : r;
    } else {
      mergedTags[id] = l || r;
    }
  }

  return {
    version: 1,
    tags: mergedTags,
  };
}

export async function loadAlbumMetadata(metaFolderId, accessToken) {
  if (!metaFolderId) {
    return {
      tagSchemaFileId: null,
      tagSchema: { version: 1, tags: {} },
      memberFilesById: {},
      membersData: {},
    };
  }

  const params = new URLSearchParams({
    q: `'${metaFolderId}' in parents and trashed = false and mimeType = 'application/json'`,
    fields: 'files(id,name,modifiedTime)',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const listResp = await fetchWithDriveBackoff(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listResp.ok) {
    throw new Error(t('metaSync.listMetaFailed', { status: listResp.status }));
  }
  const listData = await listResp.json();
  const files = listData.files || [];

  let tagSchemaFileId = null;
  let tagSchema = { version: 1, tags: {} };
  const memberFilesById = {};
  const membersData = {};

  // Fetch up to 6 JSON files concurrently
  const CONCURRENCY = 6;
  let index = 0;

  async function worker() {
    while (index < files.length) {
      const file = files[index];
      index += 1;
      try {
        const json = await fetchJsonMedia(file.id, accessToken);
        if (file.name === TAGS_SCHEMA_FILENAME) {
          tagSchemaFileId = file.id;
          if (json && typeof json.tags === 'object') {
            tagSchema = { version: 1, tags: json.tags };
          }
        } else if (file.name.startsWith('member-') && file.name.endsWith('.json')) {
          const memberId = json?.member?.id || file.name.slice(7, -5);
          memberFilesById[memberId] = file.id;
          membersData[memberId] = json;
        }
      } catch {
        // Ignore single corrupted metadata file without crashing gallery
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  return {
    tagSchemaFileId,
    tagSchema,
    memberFilesById,
    membersData,
  };
}

export async function saveMemberMetadata({
  rootFolderId,
  metaFolderId,
  existingFileId,
  memberKey,
  payload,
  accessToken,
}) {
  const folderId = metaFolderId || (await ensureMetaFolder(rootFolderId, accessToken));
  const filename = `member-${memberKey}.json`;

  let targetFileId = existingFileId;
  if (!targetFileId) {
    const found = await findChildByName(folderId, filename, 'application/json', accessToken);
    if (found) targetFileId = found.id;
  }

  if (targetFileId) {
    await updateJsonFile(targetFileId, payload, accessToken);
  } else {
    targetFileId = await createJsonFile(folderId, filename, payload, accessToken);
  }

  return { metaFolderId: folderId, fileId: targetFileId };
}

export async function saveTagSchema({
  rootFolderId,
  metaFolderId,
  existingFileId,
  localSchema,
  accessToken,
}) {
  const folderId = metaFolderId || (await ensureMetaFolder(rootFolderId, accessToken));
  let targetFileId = existingFileId;

  if (!targetFileId) {
    const found = await findChildByName(folderId, TAGS_SCHEMA_FILENAME, 'application/json', accessToken);
    if (found) targetFileId = found.id;
  }

  let mergedSchema = localSchema;
  if (targetFileId) {
    try {
      const remoteSchema = await fetchJsonMedia(targetFileId, accessToken);
      mergedSchema = mergeTagSchemas(localSchema, remoteSchema);
    } catch {
      mergedSchema = localSchema;
    }
    await updateJsonFile(targetFileId, mergedSchema, accessToken);
  } else {
    targetFileId = await createJsonFile(folderId, TAGS_SCHEMA_FILENAME, mergedSchema, accessToken);
  }

  return { metaFolderId: folderId, fileId: targetFileId, mergedSchema };
}

export async function loadLocalServerMeta(folderId) {
  const cleanId = String(folderId || '').trim();
  if (!cleanId) return null;
  try {
    const resp = await fetch(`./api/meta?folder=${encodeURIComponent(cleanId)}`, {
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json?.ok) return null;
    return {
      tagSchema: json.tagSchema || { version: 1, tags: {} },
      membersData: json.membersData || {},
    };
  } catch {
    return null;
  }
}

export async function saveLocalServerMeta({ folderId, memberId, memberRecord, tagSchema }) {
  const cleanId = String(folderId || '').trim();
  if (!cleanId) return null;
  try {
    const resp = await fetch('./api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderId: cleanId,
        memberId,
        memberRecord,
        tagSchema,
      }),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json?.ok) return null;
    return {
      tagSchema: json.tagSchema || { version: 1, tags: {} },
      membersData: json.membersData || {},
    };
  } catch {
    return null;
  }
}
