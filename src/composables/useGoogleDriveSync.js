import { computed, onMounted, onUnmounted, reactive } from 'vue'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const GOOGLE_ACCOUNTS_SCRIPT = 'https://accounts.google.com/gsi/client'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FOLDER_NAME = 'KDrawer'
/** 舊版整包 session；會在首次同步時拆分為多分頁檔並刪除 */
const LEGACY_SESSION_NAME = 'kdrawer-session.json'
const POLL_INTERVAL_MS = 12000
/** 畫布每次持久化後會觸發上傳；極短 debounce 以合併同一幀內多次 persist */
const UPLOAD_DEBOUNCE_MS = 200


function waitForGoogleAccountsScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GOOGLE_ACCOUNTS_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Google Identity Services 載入失敗')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_ACCOUNTS_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Identity Services 載入失敗'))
    document.head.appendChild(script)
  })
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function docDriveName(docId) {
  return `kd-${docId}.json`
}

function parseDocIdFromKdName(filename) {
  const m = String(filename || '').match(kdFileRe)
  return m ? m[1] : ''
}

/** v2：一個 json = 一個分頁 */
function rowToDrivePayload(row) {
  return {
    v: 2,
    id: row.id,
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
    title: row.title,
    zoomScale: row.zoomScale,
    useViewportSize: !!row.useViewportSize,
    logicalW: row.logicalW,
    logicalH: row.logicalH,
    png: row.png ?? null,
  }
}

export function useGoogleDriveSync({
  getPayload,
  applyPayload,
  mergeRemoteDocFiles,
  onLocalChange,
  showToast,
}) {
  let tokenClient = null
  let accessToken = ''
  let folderId = ''
  /** docId → Drive file id */
  let driveFileIds = new Map()
  let uploadTimer = null
  let pollTimer = null
  let unsubscribeLocalChange = null
  let migrateLegacyRan = false

  const state = reactive({
    configured: Boolean(GOOGLE_CLIENT_ID),
    signedIn: false,
    busy: false,
    status: GOOGLE_CLIENT_ID ? '未登入 Google Drive' : '尚未設定 Google Drive',
    lastSyncedAt: null,
  })

  const statusLabel = computed(() => {
    if (!state.configured) return '雲端未設定'
    if (state.busy) return state.status
    if (!state.signedIn) return '雲端未登入'
    if (state.lastSyncedAt) return '已同步 ' + state.lastSyncedAt.toLocaleTimeString()
    return state.status
  })

  function setBusy(status) {
    state.busy = true
    state.status = status
  }

  function setIdle(status) {
    state.busy = false
    state.status = status
  }

  async function initTokenClient() {
    if (!state.configured) throw new Error('尚未設定 VITE_GOOGLE_CLIENT_ID')
    if (tokenClient) return tokenClient
    await waitForGoogleAccountsScript()
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {},
    })
    return tokenClient
  }

  async function requestAccessToken(prompt = 'consent') {
    const client = await initTokenClient()
    return new Promise((resolve, reject) => {
      client.callback = response => {
        if (response?.error) {
          reject(new Error(response.error))
          return
        }
        accessToken = response.access_token || ''
        state.signedIn = Boolean(accessToken)
        if (!accessToken) {
          reject(new Error('沒有取得 Google 授權權杖'))
          return
        }
        resolve(accessToken)
      }
      client.requestAccessToken({ prompt })
    })
  }

  async function ensureAccessToken(prompt = '') {
    if (accessToken) return accessToken
    return requestAccessToken(prompt)
  }

  async function driveFetch(path, options = {}) {
    await ensureAccessToken('')
    const headers = new Headers(options.headers || {})
    headers.set('Authorization', `Bearer ${accessToken}`)
    const response = await fetch(path, { ...options, headers })
    if (response.status === 401) {
      accessToken = ''
      state.signedIn = false
    }
    if (!response.ok) {
      let message = response.statusText
      try {
        const body = await response.json()
        message = body?.error?.message || message
      } catch (_) {}
      throw new Error(message || 'Google Drive API 失敗')
    }
    return response
  }

  async function driveJson(path, options) {
    const response = await driveFetch(path, options)
    return response.json()
  }

  async function findDriveFolder() {
    const params = new URLSearchParams({
      q: `name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: '1',
    })
    const result = await driveJson(`${DRIVE_API_BASE}/files?${params}`)
    return result.files?.[0] || null
  }

  async function createDriveFolder() {
    return driveJson(`${DRIVE_API_BASE}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    })
  }

  async function ensureDriveFolder() {
    if (folderId) return folderId
    const existing = await findDriveFolder()
    const folder = existing || await createDriveFolder()
    folderId = folder.id
    return folderId
  }

  async function listFolderJsonFiles(fid) {
    const out = []
    let pageToken = ''
    for (;;) {
      const qs = new URLSearchParams({
        q: `'${fid}' in parents and mimeType='application/json' and trashed=false`,
        fields: 'nextPageToken, files(id,name)',
        pageSize: '100',
      })
      if (pageToken) qs.set('pageToken', pageToken)
      const res = await driveJson(`${DRIVE_API_BASE}/files?${qs}`)
      out.push(...(res.files || []))
      pageToken = res.nextPageToken
      if (!pageToken) break
    }
    return out
  }

  /** 重整 docId ↔ drive file id 對照 */
  async function refreshKdFileIndex(fid) {
    const files = await listFolderJsonFiles(fid)
    const next = new Map()
    for (const f of files) {
      if (f.name === LEGACY_SESSION_NAME) continue
      const docId = parseDocIdFromKdName(f.name)
      if (docId) next.set(docId, f.id)
    }
    driveFileIds = next
  }

  async function downloadFileJson(mediaFileId) {
    const response = await driveFetch(`${DRIVE_API_BASE}/files/${mediaFileId}?alt=media`, {
      headers: { Accept: 'application/json' },
    })
    return response.json()
  }

  async function migrateLegacySessionIfNeeded(fid) {
    if (migrateLegacyRan) return
    migrateLegacyRan = true
    const files = await listFolderJsonFiles(fid)
    const leg = files.find(f => f.name === LEGACY_SESSION_NAME)
    if (!leg) return
    try {
      const payload = await downloadFileJson(leg.id)
      if (payload?.v === 1 && Array.isArray(payload.documents)) {
        await applyPayload(payload)
      }
      await driveFetch(`${DRIVE_API_BASE}/files/${leg.id}`, { method: 'DELETE' })
    } catch (_) {
      /* ignore */
    }
    await refreshKdFileIndex(fid)
  }

  function createMultipartBody(metadata, payload) {
    const boundary = 'kdrawer_' + Math.random().toString(36).slice(2)
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(payload),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    return {
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    }
  }

  async function uploadDriveDoc(row) {
    const fidFolder = await ensureDriveFolder()
    await refreshKdFileIndex(fidFolder)
    const name = docDriveName(row.id)
    const existed = driveFileIds.get(row.id)
    const body = rowToDrivePayload(row)
    const metadata = {
      name,
      mimeType: 'application/json',
      ...(existed ? {} : { parents: [fidFolder] }),
    }
    const multipart = createMultipartBody(metadata, body)
    const url = existed
      ? `${DRIVE_UPLOAD_BASE}/files/${existed}?uploadType=multipart&fields=id,name`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`
    const result = await driveJson(url, {
      method: existed ? 'PATCH' : 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body,
    })
    driveFileIds.set(row.id, result.id)
  }

  async function pushAllLocalDocsQuiet() {
    const pl = typeof getPayload === 'function' ? getPayload() : null
    if (!pl?.documents?.length) return
    await ensureDriveFolder()
    await migrateLegacySessionIfNeeded(folderId)
    await refreshKdFileIndex(folderId)
    for (const row of pl.documents) {
      await uploadDriveDoc(row)
    }
    state.lastSyncedAt = new Date()
  }

  async function fetchAndMergeKdFilesQuiet() {
    await ensureDriveFolder()
    await migrateLegacySessionIfNeeded(folderId)
    await refreshKdFileIndex(folderId)
    const fid = folderId
    const files = (await listFolderJsonFiles(fid)).filter(f =>
      kdFileRe.test(f.name) || f.name === LEGACY_SESSION_NAME,
    )

    /** 若仍存在 legacy（異常）：再嘗試遷移 */
    if (files.some(f => f.name === LEGACY_SESSION_NAME)) {
      migrateLegacyRan = false
      await migrateLegacySessionIfNeeded(fid)
    }

    const kdOnly = files.filter(f => kdFileRe.test(f.name))
    const bodies = []
    for (const f of kdOnly) {
      try {
        const j = await downloadFileJson(f.id)
        if (j?.v === 2 && j.id && parseDocIdFromKdName(f.name) === j.id) bodies.push(j)
      } catch (_) { /* skip */ }
    }

    if (bodies.length && typeof mergeRemoteDocFiles === 'function') {
      await mergeRemoteDocFiles(bodies)
    }
    await refreshKdFileIndex(folderId)
  }

  async function deleteDriveDoc(docId) {
    if (!state.signedIn || !docId) return
    try {
      await ensureAccessToken('')
      const fidFolder = folderId || (await ensureDriveFolder())
      await refreshKdFileIndex(fidFolder)
      const fid = driveFileIds.get(docId)
      if (fid) {
        await driveFetch(`${DRIVE_API_BASE}/files/${fid}`, { method: 'DELETE' })
        driveFileIds.delete(docId)
      }
    } catch (e) {
      showToast?.('刪除雲端檔案失敗：' + (e?.message || '未知錯誤'))
    }
  }

  function schedulePushAll() {
    if (!state.signedIn) return
    if (uploadTimer) clearTimeout(uploadTimer)
    uploadTimer = setTimeout(() => {
      uploadTimer = null
      void (async () => {
        try {
          await ensureAccessToken('')
          /** 本機改動：僅上傳；遠端更新由輪詢 pull */
          await pushAllLocalDocsQuiet()
          state.lastSyncedAt = new Date()
        } catch (_) { /* 權杖／網路 */}
      })()
    }, UPLOAD_DEBOUNCE_MS)
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      if (!state.signedIn || state.busy) return
      void (async () => {
        try {
          await fetchAndMergeKdFilesQuiet()
          state.lastSyncedAt = new Date()
        } catch (_) { /* off-line／權杖 */ }
      })()
    }, POLL_INTERVAL_MS)
  }

  async function syncNow({ quiet = false } = {}) {
    if (!state.configured) {
      showToast?.('請先設定 VITE_GOOGLE_CLIENT_ID')
      return
    }
    setBusy('同步 Google Drive 中…')
    try {
      await ensureAccessToken('')
      await ensureDriveFolder()
      await migrateLegacySessionIfNeeded(folderId)
      /** 登入／手動同步：先把雲端拉下合併，再全部上傳本機快照 */
      await fetchAndMergeKdFilesQuiet()
      await pushAllLocalDocsQuiet()
      startPolling()
      setIdle('Google Drive 已同步')
      if (!quiet) showToast?.('已與 Google Drive（KDrawer 資料夾）同步')
    } catch (error) {
      setIdle('同步失敗')
      if (!quiet) showToast?.('Google Drive 同步失敗：' + (error?.message || '未知錯誤'))
    }
  }

  async function signIn() {
    if (!state.configured) {
      showToast?.('請設定 VITE_GOOGLE_CLIENT_ID（見 .env / .env.production）')
      return
    }
    setBusy('等待 Google 授權…')
    migrateLegacyRan = false
    try {
      await requestAccessToken('consent')
      setBusy('同步 Google Drive 中…')
      await syncNow({ quiet: true })
      showToast?.('已登入並同步 Google Drive')
    } catch (error) {
      setIdle('登入失敗')
      showToast?.('Google Drive 登入失敗：' + (error?.message || '未知錯誤'))
    }
  }

  async function signOut() {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {})
    }
    accessToken = ''
    state.signedIn = false
    folderId = ''
    driveFileIds = new Map()
    migrateLegacyRan = false
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (uploadTimer) clearTimeout(uploadTimer)
    uploadTimer = null
    setIdle('已登出 Google Drive')
    showToast?.('已登出 Google Drive，改為本機模式')
  }

  onMounted(() => {
    unsubscribeLocalChange = onLocalChange?.(() => schedulePushAll()) || null
  })

  onUnmounted(() => {
    if (uploadTimer) clearTimeout(uploadTimer)
    if (pollTimer) clearInterval(pollTimer)
    unsubscribeLocalChange?.()
  })

  return {
    state,
    statusLabel,
    signIn,
    signOut,
    syncNow,
    deleteDriveDoc,
  }
}
