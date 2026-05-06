import { computed, onMounted, reactive } from 'vue'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const GOOGLE_ACCOUNTS_SCRIPT = 'https://accounts.google.com/gsi/client'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_FOLDER_NAME = 'KDrawer'
/** 舊版整包 session；會在首次同步時拆分為多分頁檔並刪除 */
const LEGACY_SESSION_NAME = 'kdrawer-session.json'
/** GIS script 已插入但 load 早於我們掛 listener 時，用輪詢補救 */
const GIS_SCRIPT_POLL_MS = 50
const GIS_SCRIPT_POLL_MAX = 200
/** OAuth 彈窗若未回呼（關閉視窗、阻擋彈窗）會永遠 pending，須逾時 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180000
/** 背景分頁可能大幅延遲單次 setTimeout；用週期檢查截止時間較可靠 */
const OAUTH_WATCHDOG_INTERVAL_MS = 1500
/** 單一 Drive API fetch 上限；避免網路掛死時按鈕永遠 busy */
const DRIVE_FETCH_TIMEOUT_MS = 45000
/** 重新整理後還原登入；與 access_token 過期時間一併儲存（XSS 風險與一般 SPA token 相同） */
const OAUTH_STORAGE_KEY = 'kdrawer-gdrive-oauth-v1'
/** 比對 token 過期時提早更新，避免邊界秒數送 API 失敗 */
const TOKEN_EXPIRY_SKEW_MS = 60_000


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
  showToast,
}) {
  let tokenClient = null
  let accessToken = ''
  /** access_token 預估過期時間（毫秒 epoch）；來自 OAuth 回應 expires_in */
  let tokenExpiresAt = 0
  let folderId = ''
  /** docId → Drive file id */
  let driveFileIds = new Map()
  /** docId → 雲端檔 appProperties 紀錄的 updatedAt（毫秒） */
  let driveRemoteUpdatedAt = new Map()
  /** docId → 最近一次下載的 JSON body.updatedAt（與合併／上傳比對用） */
  let remoteJsonUpdatedAt = new Map()
  let migrateLegacyRan = false
  /** 避免連點或並行 ensureAccessToken / signIn 覆寫 GIS callback 造成 Promise 永不結束 */
  let inflightTokenRequest = null

  const state = reactive({
    configured: Boolean(GOOGLE_CLIENT_ID),
    signedIn: false,
    busy: false,
    status: GOOGLE_CLIENT_ID ? '未登入 Google Drive' : '尚未設定 Google Drive',
    lastSyncedAt: null,
  })

  function setSignedIn(value) {
    state.signedIn = value
  }

  const statusLabel = computed(() => {
    if (!state.configured) return '雲端未設定'
    if (state.busy) return state.status
    if (!state.signedIn) return '雲端未登入'
    if (state.lastSyncedAt) return '上次上傳 ' + state.lastSyncedAt.toLocaleTimeString()
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

  function readPersistedOAuth() {
    if (!GOOGLE_CLIENT_ID) return null
    try {
      const raw = localStorage.getItem(OAUTH_STORAGE_KEY)
      if (!raw) return null
      const o = JSON.parse(raw)
      if (o?.v !== 1 || o.clientId !== GOOGLE_CLIENT_ID) return null
      if (typeof o.accessToken !== 'string' || !o.accessToken) return null
      if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null
      return { accessToken: o.accessToken, expiresAt: o.expiresAt }
    } catch (_) {
      return null
    }
  }

  function clearPersistedOAuth() {
    try {
      localStorage.removeItem(OAUTH_STORAGE_KEY)
    } catch (_) {}
  }

  function persistOAuthSession(token, expiresInSec) {
    if (!GOOGLE_CLIENT_ID || !token) return
    const ei = Number(expiresInSec)
    const expiresIn = Number.isFinite(ei) && ei > 0 ? ei : 3600
    tokenExpiresAt = Date.now() + expiresIn * 1000
    try {
      localStorage.setItem(
        OAUTH_STORAGE_KEY,
        JSON.stringify({
          v: 1,
          clientId: GOOGLE_CLIENT_ID,
          accessToken: token,
          expiresAt: tokenExpiresAt,
        }),
      )
    } catch (_) {}
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
    if (inflightTokenRequest) return inflightTokenRequest

    inflightTokenRequest = (async () => {
      const client = await initTokenClient()
      return await new Promise((resolve, reject) => {
        let watchdogId = null
        let finished = false
        const oauthDeadline = Date.now() + OAUTH_CALLBACK_TIMEOUT_MS
        const finish = (fn, arg) => {
          if (finished) return
          finished = true
          if (watchdogId !== null) {
            clearInterval(watchdogId)
            watchdogId = null
          }
          fn(arg)
        }

        watchdogId = setInterval(() => {
          if (finished) return
          if (Date.now() >= oauthDeadline) {
            client.callback = () => {}
            finish(reject, new Error('授權逾時：請允許彈出視窗並完成 Google 登入，或稍後再試'))
          }
        }, OAUTH_WATCHDOG_INTERVAL_MS)

        client.callback = response => {
          if (response?.error) {
            finish(reject, new Error(response.error))
            return
          }
          accessToken = response.access_token || ''
          if (accessToken) persistOAuthSession(accessToken, response.expires_in)
          else tokenExpiresAt = 0
          setSignedIn(Boolean(accessToken))
          if (!accessToken) {
            finish(reject, new Error('沒有取得 Google 授權權杖'))
            return
          }
          finish(resolve, accessToken)
        }
        client.requestAccessToken({ prompt })
      })
    })()

    try {
      return await inflightTokenRequest
    } finally {
      inflightTokenRequest = null
    }
  }

  async function ensureAccessToken(prompt = '') {
    const now = Date.now()
    if (accessToken && now < tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) return accessToken

    if (accessToken) {
      accessToken = ''
      tokenExpiresAt = 0
    }

    const stored = readPersistedOAuth()
    if (stored && now < stored.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      accessToken = stored.accessToken
      tokenExpiresAt = stored.expiresAt
      setSignedIn(true)
      return accessToken
    }

    if (stored) clearPersistedOAuth()

    return requestAccessToken(prompt)
  }

  async function driveFetch(path, options = {}) {
    await ensureAccessToken('')
    const headers = new Headers(options.headers || {})
    headers.set('Authorization', `Bearer ${accessToken}`)
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), DRIVE_FETCH_TIMEOUT_MS)
    let response
    try {
      response = await fetch(path, { ...options, headers, signal: ctrl.signal })
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error('Google Drive 連線逾時，請檢查網路後再試')
      }
      throw e
    } finally {
      clearTimeout(tid)
    }
    if (response.status === 401) {
      accessToken = ''
      tokenExpiresAt = 0
      clearPersistedOAuth()
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
  /** @returns {Promise<boolean>} 是否實際上傳（雲端較新而略過時為 false） */
  async function uploadDriveDoc(row, usedBaseNames, { skipIndexRefresh = false } = {}) {
    const fidFolder = await ensureDriveFolder()
    if (!skipIndexRefresh) await refreshKdFileIndex(fidFolder)
    const name = driveJsonFilenameForRow(row, usedBaseNames)
    const existed = driveFileIds.get(row.id)
    const localUt = localRowUpdatedAt(row)
    const remoteUt = remoteTimestampForDoc(row.id)
    if (existed && remoteUt > localUt) return false

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
    return true
  }

  /** 手動：將單一分頁上傳到 KDrawer 資料夾（與其他分頁檔名不重複） */
  async function saveDocToCloud(docId, { quiet = false } = {}) {
    if (!state.configured) {
      showToast?.('請先設定 VITE_GOOGLE_CLIENT_ID')
      if (state.busy) setIdle('雲端未設定')
      return
    }
    if (!docId) return
    const pl = typeof getPayload === 'function' ? getPayload() : null
    const row = pl?.documents?.find(d => d.id === docId)
    if (!row) {
      if (!quiet) showToast?.('找不到此分頁')
      return
    }
    setBusy('上傳到 Google Drive…')
    try {
      await ensureAccessToken('')
      await ensureDriveFolder()
      await migrateLegacySessionIfNeeded(folderId)
      await refreshKdFileIndex(folderId)
      const usedNames = new Set()
      for (const d of pl.documents) {
        if (d.id === docId) continue
        driveJsonFilenameForRow(d, usedNames)
      }
      const uploaded = await uploadDriveDoc(row, usedNames, { skipIndexRefresh: true })
      state.lastSyncedAt = new Date()
      setIdle('已上傳 Google Drive')
      if (!quiet) {
        showToast?.(
          uploaded ? '此分頁已存到 Google Drive' : '雲端版本較新，未上傳（請先從雲端匯入或在本機編輯後再試）',
        )
      }
    } catch (error) {
      setIdle('上傳失敗')
      if (!quiet) showToast?.('存到雲端失敗：' + (error?.message || '未知錯誤'))
    }
  }

  /** 供「從雲端匯入」列出 KDrawer 資料夾內可選的 JSON */
  async function listDriveJsonFilesForImport() {
    await ensureAccessToken('')
    const fid = await ensureDriveFolder()
    await migrateLegacySessionIfNeeded(fid)
    const files = await listFolderJsonFiles(fid)
    return files
      .map(f => ({
        id: f.id,
        name: f.name || '(無檔名)',
        docId: parseDocIdFromDriveFile(f) || null,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'))
  }

  /** 下載單一檔並合併進本機（v2 單頁 JSON 或舊版 v1 整包） */
  async function importDriveJsonFile(fileId) {
    await ensureAccessToken('')
    const j = await downloadFileJson(fileId)
    if (j?.v === 2 && typeof j.id === 'string' && j.id && typeof mergeRemoteDocFiles === 'function') {
      await mergeRemoteDocFiles([j])
      await refreshKdFileIndex(folderId || (await ensureDriveFolder()))
      return
    }
    if (j?.v === 1 && Array.isArray(j.documents) && j.documents.length && typeof applyPayload === 'function') {
      await applyPayload(j)
      await refreshKdFileIndex(folderId || (await ensureDriveFolder()))
      return
    }
    throw new Error('不是可匯入的 KDrawer JSON（需 v2 分頁檔或舊版整包）')
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
      setIdle('已登入 Google Drive')
      showToast?.('已登入；編輯仍存本機，請於各分頁按「存到雲端」上傳')
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
    tokenExpiresAt = 0
    clearPersistedOAuth()
    setSignedIn(false)
    folderId = ''
    driveFileIds = new Map()
    driveRemoteUpdatedAt = new Map()
    remoteJsonUpdatedAt = new Map()
    migrateLegacyRan = false
    setIdle('已登出 Google Drive')
    showToast?.('已登出 Google Drive，改為本機模式')
  }

  /** 重新整理後：若 localStorage 仍有有效權杖，僅還原登入狀態（不自動拉雲端／上傳） */
  async function restoreSessionIfPersisted() {
    const stored = readPersistedOAuth()
    if (!stored) return
    const now = Date.now()
    if (now >= stored.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      clearPersistedOAuth()
      return
    }
    accessToken = stored.accessToken
    tokenExpiresAt = stored.expiresAt
    setSignedIn(true)
    state.status = '已登入 Google Drive'
  }

  onMounted(() => {
    if (state.configured) void restoreSessionIfPersisted()
  })

  return {
    state,
    statusLabel,
    signIn,
    signOut,
    saveDocToCloud,
    listDriveJsonFilesForImport,
    importDriveJsonFile,
  }
}
