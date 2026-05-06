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
/** GIS script 已插入但 load 早於我們掛 listener 時，用輪詢補救 */
const GIS_SCRIPT_POLL_MS = 50
const GIS_SCRIPT_POLL_MAX = 200
/** OAuth 彈窗若未回呼（關閉視窗、阻擋彈窗）會永遠 pending，須逾時 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180000


function waitForGoogleAccountsScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let settled = false
    const ok = () => {
      if (settled || !window.google?.accounts?.oauth2) return
      settled = true
      resolve()
    }
    const fail = message => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }

    const existing = document.querySelector(`script[src="${GOOGLE_ACCOUNTS_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', ok, { once: true })
      existing.addEventListener('error', () => fail('Google Identity Services 載入失敗'), { once: true })
      let n = 0
      const iv = setInterval(() => {
        if (window.google?.accounts?.oauth2) {
          clearInterval(iv)
          ok()
          return
        }
        if (++n >= GIS_SCRIPT_POLL_MAX) {
          clearInterval(iv)
          fail('Google Identity Services 載入逾時')
        }
      }, GIS_SCRIPT_POLL_MS)
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_ACCOUNTS_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => {
      let n = 0
      const iv = setInterval(() => {
        if (window.google?.accounts?.oauth2) {
          clearInterval(iv)
          ok()
          return
        }
        if (++n >= GIS_SCRIPT_POLL_MAX) {
          clearInterval(iv)
          fail('Google Identity Services 載入逾時')
        }
      }, GIS_SCRIPT_POLL_MS)
    }
    script.onerror = () => fail('Google Identity Services 載入失敗')
    document.head.appendChild(script)
  })
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

const APP_PROP_DOC_ID = 'kdrawer_id'
/** 與 JSON body.updatedAt 對齊，供 list 比對誰較新而不必下載整檔 */
const APP_PROP_UPDATED_AT = 'kdrawer_updated_at'
/** 舊版檔名：kd-{docId}.json */
const KD_LEGACY_FILE_RE = /^kd-(.+)\.json$/i

function sanitizeTitleForDriveFilename(title) {
  let s = String(title ?? '').trim()
  if (!s) s = 'untitled'
  s = s.replace(/[/\\]/g, '-').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[\s.]+|[\s.]+$/g, '')
  if (!s) s = 'untitled'
  const max = 200
  if (s.length > max) s = s.slice(0, max).trim()
  return s
}

/** 同一批上傳時避免「分頁同名」衝突 */
function driveJsonFilenameForRow(row, usedNames) {
  const base = sanitizeTitleForDriveFilename(row.title)
  let name = `${base}.json`
  if (usedNames.has(name)) {
    const tail = String(row.id || '')
      .replace(/^doc-/, '')
      .slice(-12) || 'doc'
    name = `${base} (${tail}).json`
  }
  usedNames.add(name)
  return name
}

function parseDocIdFromDriveFile(f) {
  const legacy = String(f?.name || '').match(KD_LEGACY_FILE_RE)
  if (legacy) return legacy[1]
  const ap = f?.appProperties
  if (ap && typeof ap[APP_PROP_DOC_ID] === 'string' && ap[APP_PROP_DOC_ID]) return ap[APP_PROP_DOC_ID]
  return ''
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
  /** 雲端拉取合併並上傳成功後（含手動同步／登入後同步） */
  onCloudSyncSuccess,
  /** 與 state.signedIn 同步更新（供 painter 在 token 回呼當下即關閉本機 JSON 寫入） */
  mirrorSignedInRef = null,
}) {
  let tokenClient = null
  let accessToken = ''
  let folderId = ''
  /** docId → Drive file id */
  let driveFileIds = new Map()
  /** docId → 雲端檔 appProperties 紀錄的 updatedAt（毫秒） */
  let driveRemoteUpdatedAt = new Map()
  /** docId → 最近一次下載的 JSON body.updatedAt（與合併／上傳比對用） */
  let remoteJsonUpdatedAt = new Map()
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

  function setSignedIn(value) {
    state.signedIn = value
    if (mirrorSignedInRef) mirrorSignedInRef.value = value
  }

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
      let timeoutId = null
      let finished = false
      const finish = (fn, arg) => {
        if (finished) return
        finished = true
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        fn(arg)
      }

      timeoutId = setTimeout(() => {
        timeoutId = null
        client.callback = () => {}
        finish(reject, new Error('授權逾時：請允許彈出視窗並完成 Google 登入，或稍後再試'))
      }, OAUTH_CALLBACK_TIMEOUT_MS)

      client.callback = response => {
        if (response?.error) {
          finish(reject, new Error(response.error))
          return
        }
        accessToken = response.access_token || ''
        setSignedIn(Boolean(accessToken))
        if (!accessToken) {
          finish(reject, new Error('沒有取得 Google 授權權杖'))
          return
        }
        finish(resolve, accessToken)
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
      setSignedIn(false)
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
        fields: 'nextPageToken, files(id,name,appProperties)',
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

  /** 重整 docId ↔ file id，以及雲端 appProperties 的 updatedAt */
  async function refreshKdFileIndex(fid) {
    const files = await listFolderJsonFiles(fid)
    const nextIds = new Map()
    const nextUt = new Map()
    for (const f of files) {
      if (f.name === LEGACY_SESSION_NAME) continue
      const docId = parseDocIdFromDriveFile(f)
      if (!docId) continue
      nextIds.set(docId, f.id)
      const ap = f.appProperties || {}
      const raw = ap[APP_PROP_UPDATED_AT]
      const ut = typeof raw === 'string' && raw !== '' ? Number(raw) : NaN
      nextUt.set(docId, Number.isFinite(ut) ? ut : 0)
    }
    driveFileIds = nextIds
    driveRemoteUpdatedAt = nextUt
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

  function localRowUpdatedAt(row) {
    const u = row?.updatedAt
    return typeof u === 'number' && Number.isFinite(u) ? u : 0
  }

  function remoteTimestampForDoc(docId) {
    return Math.max(
      driveRemoteUpdatedAt.get(docId) ?? 0,
      remoteJsonUpdatedAt.get(docId) ?? 0,
    )
  }

  /**
   * 僅在本機 JSON（payload）updatedAt ≥ 雲端已知時間時上傳，避免舊本機蓋掉較新雲端。
   * 新檔（雲端尚無此 docId）一律建立。
   */
  async function uploadDriveDoc(row, usedBaseNames, { skipIndexRefresh = false } = {}) {
    const fidFolder = await ensureDriveFolder()
    if (!skipIndexRefresh) await refreshKdFileIndex(fidFolder)
    const name = driveJsonFilenameForRow(row, usedBaseNames)
    const existed = driveFileIds.get(row.id)
    const localUt = localRowUpdatedAt(row)
    const remoteUt = remoteTimestampForDoc(row.id)
    if (existed && remoteUt > localUt) return

    const body = rowToDrivePayload(row)
    const metadata = {
      name,
      mimeType: 'application/json',
      appProperties: {
        [APP_PROP_DOC_ID]: String(row.id),
        [APP_PROP_UPDATED_AT]: String(localUt),
      },
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
    driveRemoteUpdatedAt.set(row.id, localUt)
    remoteJsonUpdatedAt.set(row.id, localUt)
  }

  async function pushAllLocalDocsQuiet() {
    const pl = typeof getPayload === 'function' ? getPayload() : null
    if (!pl?.documents?.length) return
    await ensureDriveFolder()
    await migrateLegacySessionIfNeeded(folderId)
    await refreshKdFileIndex(folderId)
    const usedNames = new Set()
    for (const row of pl.documents) {
      await uploadDriveDoc(row, usedNames, { skipIndexRefresh: true })
    }
    state.lastSyncedAt = new Date()
  }

  async function fetchAndMergeKdFilesQuiet() {
    await ensureDriveFolder()
    await migrateLegacySessionIfNeeded(folderId)
    await refreshKdFileIndex(folderId)

    /**
     * 比對 appProperties 的 updatedAt 與上次下載的快取值，
     * 只下載「雲端確實更新過」的檔案，避免每次 poll 都全量下載。
     */
    const bodies = []
    for (const [docId, fileId] of driveFileIds) {
      const remoteUt = driveRemoteUpdatedAt.get(docId) ?? 0
      const cachedUt = remoteJsonUpdatedAt.get(docId) ?? 0
      if (remoteUt <= cachedUt) continue
      try {
        const j = await downloadFileJson(fileId)
        if (j?.v === 2 && j.id) {
          const rut = typeof j.updatedAt === 'number' && Number.isFinite(j.updatedAt) ? j.updatedAt : 0
          remoteJsonUpdatedAt.set(j.id, Math.max(remoteJsonUpdatedAt.get(j.id) ?? 0, rut))
          bodies.push(j)
        }
      } catch (_) { /* skip */ }
    }

    if (bodies.length && typeof mergeRemoteDocFiles === 'function') {
      await mergeRemoteDocFiles(bodies)
      await refreshKdFileIndex(folderId)
    }
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
          /** 先拉雲端 JSON 合併（依 updatedAt），再只把本機較新的推上去 */
          await fetchAndMergeKdFilesQuiet()
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
      try {
        onCloudSyncSuccess?.()
      } catch (_) {}
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
    setSignedIn(false)
    folderId = ''
    driveFileIds = new Map()
    driveRemoteUpdatedAt = new Map()
    remoteJsonUpdatedAt = new Map()
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
