/**
 * storage-core.js — 全域大容量儲存橋接核心 (IndexedDB + localForage + 智能備份異動追蹤 + 跨視窗同步 + 行動端 bfcache 自動重連)
 * 架構設計：
 * 1. 底層使用 IndexedDB (透過 localforage)，容量達數百 MB 至數 GB。
 * 2. 過渡期安全機制 (DUAL_WRITE_MODE，可透過首頁儲存診斷視窗動態切換)：
 *    - 讀取時：優先從 IndexedDB 讀取（附 2500ms 逾時保護與失敗自動重連重試）；若仍無或失敗，無縫降級讀取 localStorage 並自動搬遷回 IndexedDB。
 *    - 寫入時：若啟用雙寫，先「同步」寫入 localStorage（防 beforeunload 非同步中斷），再非同步寫入 IndexedDB（失敗重試並強制備援 localStorage）。
 * 3. 手機 PWA 穩定性強化：
 *    - 以 createDbInstance() 工廠建立資料庫實例，提供 AppStorage.reconnect() 供異常或行動瀏覽器 bfcache 還原時重建連線。
 *    - 內建 pageshow 事件監聽，全套 13 個子系統無需修改 HTML 即可自動受惠。
 * 4. 智能備份追蹤：自動偵測 13 大模組的實質資料異動次數，供首頁顯示智能備份提醒。
 * 5. 跨視窗同步 (BroadcastChannel)：
 *    - 任一子視窗異動核心業務資料後，自動廣播通知首頁即時刷新財務健康快報列。
 *    - 主視窗切換/建立/刪除身分或匯入備份時，廣播通知所有已開啟子視窗鎖定寫入並自動重載，防止舊身分資料覆蓋新身分。
 * 6. 自動呼叫 navigator.storage.persist() 申請瀏覽器持久化儲存保護。
 */
(function (global) {
    'use strict';

    const DUAL_WRITE_PREF_KEY = 'LIFESTYLE_DUAL_WRITE_MODE_V1';
    const BACKUP_TRACKER_KEY = 'LIFESTYLE_BACKUP_TRACKER_V1';
    const SYNC_CHANNEL_NAME = 'LIFESTYLE_SYNC_CHANNEL_V1';
    const IDB_TIMEOUT_MS = 2500;

    function readDualWritePref() {
        try {
            const raw = localStorage.getItem(DUAL_WRITE_PREF_KEY);
            if (raw === 'false') return false;
            return true;
        } catch (e) {
            return true;
        }
    }

    let dualWriteMode = readDualWritePref();
    let isSwitchingProfileReload = false;

    // 工廠函式：建立獨立的 localForage 資料庫實例（供初始化與斷線重建使用）
    function createDbInstance() {
        if (typeof localforage === 'undefined') {
            return null;
        }
        try {
            return localforage.createInstance({
                name: 'LifeStyleArchitectureDB',
                storeName: 'financial_modules_store',
                description: '生活型態財務邏輯規劃系統大容量資料庫'
            });
        } catch (err) {
            console.warn('[AppStorage] 建立 localForage 實例失敗:', err);
            return null;
        }
    }

    let db = createDbInstance();

    // 逾時保護包裝：防止行動瀏覽器從 bfcache 返回時 IndexedDB 交易掛起卡死
    function withTimeout(promise, ms) {
        const timeoutMs = typeof ms === 'number' && ms > 0 ? ms : IDB_TIMEOUT_MS;
        let timerId = null;
        const timeoutPromise = new Promise(function (_, reject) {
            timerId = setTimeout(function () {
                reject(new Error('IndexedDB 操作逾時 (' + timeoutMs + 'ms)'));
            }, timeoutMs);
        });
        return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(function () {
            if (timerId !== null) {
                clearTimeout(timerId);
            }
        });
    }

    // 判斷當前頁面是否為導覽首頁中樞 (index.html)
    function isIndexHubPage() {
        try {
            if (typeof window === 'undefined') return false;
            if (window.__IS_INDEX_HUB__ === true) return true;
            const path = (window.location && window.location.pathname) ? window.location.pathname.toLowerCase() : '';
            return path === '' || path === '/' || path.endsWith('/') || path.endsWith('/index.html') || path === 'index.html';
        } catch (e) {
            return false;
        }
    }

    // 初始化跨視窗廣播通道 (BroadcastChannel)，不支援時靜默略過
    let syncChannel = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
            syncChannel.onmessage = function (event) {
                const msg = event && event.data;
                if (!msg || typeof msg !== 'object') return;

                // 主視窗切換身分或匯入備份時：非首頁子視窗立即鎖定寫入並重載，防止舊身分快取覆蓋新身分
                if ((msg.type === 'PROFILE_CHANGED' || msg.type === 'PROFILE_IMPORTED') && !isIndexHubPage()) {
                    isSwitchingProfileReload = true;
                    try {
                        window.location.reload();
                    } catch (reloadErr) {
                        console.warn('[AppStorage] 跨視窗重載失敗:', reloadErr);
                    }
                }
            };
        }
    } catch (bcErr) {
        syncChannel = null;
    }

    function broadcastSyncMessage(payload) {
        if (!syncChannel || !payload || typeof payload !== 'object') return;
        try {
            syncChannel.postMessage(payload);
        } catch (e) {
            console.warn('[AppStorage] 跨視窗廣播失敗:', e);
        }
    }

    // 申請瀏覽器持久化儲存保護（降低快取被自動清理風險）
    async function requestPersistentStorage() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                const isPersisted = await navigator.storage.persisted();
                if (!isPersisted) {
                    await navigator.storage.persist();
                }
            }
        } catch (err) {
            console.warn('[AppStorage] 持久化儲存權限申請略過:', err);
        }
    }

    if (typeof window !== 'undefined') {
        requestPersistentStorage();
    }

    // 判斷是否為核心業務資料鍵值（排除中樞 metadata、UI 主題與追蹤器本身）
    function isTrackableBusinessKey(key) {
        if (!key) return false;
        const ignoredPrefixes = [
            'LIFESTYLE_MULTI_PROFILES_META',
            'LIFESTYLE_PROFILE_STORE_',
            'LIFESTYLE_BACKUP_TRACKER',
            'LIFESTYLE_DUAL_WRITE_MODE',
            'LIFESTYLE_MULTI_WINDOW_MODE',
            'SESSION_'
        ];
        const ignoredExact = [
            'annual_goals_dark_mode',
            'etf_scale_ui_state_v4',
            'ETF_PORTFOLIO_UI_COLLAPSED_STATE_V2',
            'annual_asset_collapsed_fmt_v5'
        ];
        if (ignoredExact.includes(key)) return false;
        return !ignoredPrefixes.some(function (prefix) {
            return key.startsWith(prefix);
        });
    }

    // 紀錄實質資料異動（具備 3 秒防抖窗口，避免連續打字重複計數）
    let lastMutationTimestamp = 0;
    let lastMutatedKey = '';
    async function recordDataMutation(key) {
        if (!isTrackableBusinessKey(key) || !db) return;
        const now = Date.now();
        if (key === lastMutatedKey && (now - lastMutationTimestamp) < 3000) {
            return;
        }
        lastMutationTimestamp = now;
        lastMutatedKey = key;

        try {
            const raw = await withTimeout(db.getItem(BACKUP_TRACKER_KEY), IDB_TIMEOUT_MS);
            let tracker = { changeCount: 0, lastChangedAt: null, lastChangedKey: '' };
            if (raw) {
                tracker = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            }
            tracker.changeCount = (tracker.changeCount || 0) + 1;
            tracker.lastChangedAt = new Date().toISOString();
            tracker.lastChangedKey = key;
            await withTimeout(db.setItem(BACKUP_TRACKER_KEY, JSON.stringify(tracker)), IDB_TIMEOUT_MS);
        } catch (e) {
            // 追蹤器失敗不影響主業務寫入
        }
    }

    // 估算目前 localStorage 已使用大小 (Bytes)
    function estimateLocalStorageBytes() {
        let totalBytes = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                const v = localStorage.getItem(k) || '';
                totalBytes += (k.length + v.length) * 2;
            }
        } catch (e) {}
        return totalBytes;
    }

    // 安全備援寫入 localStorage
    function safeLocalStorageSet(key, stringified) {
        try {
            localStorage.setItem(key, stringified);
            return true;
        } catch (quotaErr) {
            console.warn('[AppStorage] localStorage 寫入受限 (' + key + '):', quotaErr);
            return false;
        }
    }

    // 安全讀取 localStorage
    function safeLocalStorageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    let reconnectInFlight = null;

    const AppStorage = {
        __initialized: true,

        get DUAL_WRITE_MODE() {
            return dualWriteMode;
        },

        getDualWriteMode() {
            return dualWriteMode;
        },

        setDualWriteMode(enabled) {
            dualWriteMode = !!enabled;
            try {
                localStorage.setItem(DUAL_WRITE_PREF_KEY, dualWriteMode ? 'true' : 'false');
            } catch (e) {}
            return dualWriteMode;
        },

        async init() {
            if (!db) {
                db = createDbInstance();
            }
            await requestPersistentStorage();
        },

        /**
         * 重建 IndexedDB (localForage) 連線實例（修復行動裝置 bfcache 還原後連線失效問題）
         */
        async reconnect() {
            if (reconnectInFlight) {
                return await reconnectInFlight;
            }
            reconnectInFlight = (async function () {
                try {
                    db = createDbInstance();
                    if (db && typeof db.ready === 'function') {
                        await withTimeout(db.ready(), IDB_TIMEOUT_MS);
                    }
                    return !!db;
                } catch (err) {
                    console.warn('[AppStorage.reconnect] 重建 IndexedDB 連線失敗或逾時，將保留 localStorage 備援:', err);
                    return false;
                } finally {
                    reconnectInFlight = null;
                }
            })();
            return await reconnectInFlight;
        },

        /**
         * 讀取資料（支援 2500ms 逾時保護、失敗自動重連重試、以及 localStorage 無縫降級與搬遷）
         */
        async getItem(key) {
            if (db) {
                try {
                    const idbVal = await withTimeout(db.getItem(key), IDB_TIMEOUT_MS);
                    if (idbVal !== null && idbVal !== undefined) {
                        return idbVal;
                    }
                } catch (err) {
                    console.warn('[AppStorage.getItem] IndexedDB 首次讀取失敗或逾時 (' + key + ')，嘗試重連重試:', err);
                    const reconnected = await this.reconnect();
                    if (reconnected && db) {
                        try {
                            const retryVal = await withTimeout(db.getItem(key), IDB_TIMEOUT_MS);
                            if (retryVal !== null && retryVal !== undefined) {
                                return retryVal;
                            }
                        } catch (retryErr) {
                            console.warn('[AppStorage.getItem] 重試仍失敗 (' + key + ')，降級讀取 localStorage:', retryErr);
                        }
                    }
                }
            }

            const legacyVal = safeLocalStorageGet(key);
            if (legacyVal !== null && legacyVal !== undefined) {
                if (db) {
                    withTimeout(db.setItem(key, legacyVal), IDB_TIMEOUT_MS).catch(function () {});
                }
                return legacyVal;
            }

            return null;
        },

        /**
         * 寫入資料：
         * 1. 若開啟雙寫模式，優先同步寫入 localStorage 確保頁面關閉瞬間（beforeunload）資料不中斷。
         * 2. IndexedDB 寫入加上 2500ms 逾時保護與失敗重連重試；若最終寫入失敗，強制備援寫入 localStorage。
         * 3. 實質異動時更新備份追蹤器並透過 BroadcastChannel 廣播通知其他視窗。
         */
        async setItem(key, value) {
            if (isSwitchingProfileReload) {
                return;
            }

            const stringified = (typeof value === 'object' && value !== null)
                ? JSON.stringify(value)
                : String(value);

            let wroteToLocalStorage = false;
            if (dualWriteMode || !db) {
                wroteToLocalStorage = safeLocalStorageSet(key, stringified);
            }

            let isActualChange = true;
            let idbWriteSuccess = false;

            if (db) {
                try {
                    const prevVal = await withTimeout(db.getItem(key), IDB_TIMEOUT_MS);
                    if (prevVal === stringified) {
                        isActualChange = false;
                    }
                    await withTimeout(db.setItem(key, stringified), IDB_TIMEOUT_MS);
                    idbWriteSuccess = true;
                } catch (err) {
                    console.warn('[AppStorage.setItem] IndexedDB 寫入失敗或逾時 (' + key + ')，嘗試重連重試:', err);
                    const reconnected = await this.reconnect();
                    if (reconnected && db) {
                        try {
                            await withTimeout(db.setItem(key, stringified), IDB_TIMEOUT_MS);
                            idbWriteSuccess = true;
                        } catch (retryErr) {
                            console.error('[AppStorage.setItem] IndexedDB 重試寫入失敗 (' + key + '):', retryErr);
                        }
                    }
                }
            }

            // 若 IndexedDB 寫入失敗且尚未寫入 localStorage，強制備援寫入 localStorage
            if (!idbWriteSuccess && !wroteToLocalStorage) {
                safeLocalStorageSet(key, stringified);
            }

            if (isActualChange) {
                await recordDataMutation(key);
                if (isTrackableBusinessKey(key)) {
                    broadcastSyncMessage({
                        type: 'DATA_UPDATED',
                        key: key,
                        timestamp: Date.now()
                    });
                }
            }
        },

        /**
         * 移除單一資料鍵值（含 2500ms 逾時保護與重試）
         */
        async removeItem(key) {
            if (isSwitchingProfileReload) {
                return;
            }

            try {
                localStorage.removeItem(key);
            } catch (err) {
                console.warn('[AppStorage.removeItem] localStorage 移除異常 (' + key + '):', err);
            }

            if (db) {
                try {
                    await withTimeout(db.removeItem(key), IDB_TIMEOUT_MS);
                } catch (err) {
                    console.warn('[AppStorage.removeItem] IndexedDB 移除失敗或逾時 (' + key + ')，嘗試重連重試:', err);
                    const reconnected = await this.reconnect();
                    if (reconnected && db) {
                        try {
                            await withTimeout(db.removeItem(key), IDB_TIMEOUT_MS);
                        } catch (retryErr) {
                            console.error('[AppStorage.removeItem] IndexedDB 重試移除失敗 (' + key + '):', retryErr);
                        }
                    }
                }
            }

            if (isTrackableBusinessKey(key)) {
                broadcastSyncMessage({
                    type: 'DATA_UPDATED',
                    key: key,
                    timestamp: Date.now()
                });
            }
        },

        /**
         * 跨視窗廣播介面
         */
        broadcast(payload) {
            broadcastSyncMessage(payload);
        },

        broadcastDataUpdate(key) {
            broadcastSyncMessage({
                type: 'DATA_UPDATED',
                key: key || '',
                timestamp: Date.now()
            });
        },

        broadcastProfileChange(reason) {
            broadcastSyncMessage({
                type: 'PROFILE_CHANGED',
                reason: reason || 'switch',
                timestamp: Date.now()
            });
        },

        /**
         * 取得所有已儲存的 Key 列表（合併 IndexedDB 與 localStorage，含逾時保護）
         */
        async getAllKeys() {
            const keySet = new Set();
            if (db) {
                try {
                    const idbKeys = await withTimeout(db.keys(), IDB_TIMEOUT_MS);
                    if (Array.isArray(idbKeys)) {
                        idbKeys.forEach(function (k) { keySet.add(k); });
                    }
                } catch (err) {
                    console.warn('[AppStorage.getAllKeys] IndexedDB 取得鍵值逾時或失敗，嘗試重連重試:', err);
                    const reconnected = await this.reconnect();
                    if (reconnected && db) {
                        try {
                            const retryKeys = await withTimeout(db.keys(), IDB_TIMEOUT_MS);
                            if (Array.isArray(retryKeys)) {
                                retryKeys.forEach(function (k) { keySet.add(k); });
                            }
                        } catch (retryErr) {
                            console.error('[AppStorage.getAllKeys] IndexedDB 重試取得鍵值失敗:', retryErr);
                        }
                    }
                }
            }

            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k) keySet.add(k);
                }
            } catch (e) {}
            return Array.from(keySet);
        },

        async keys() {
            return await this.getAllKeys();
        },

        /**
         * 一次性全量預先掃描複製（將目前 localStorage 中所有現存資料安全複製進 IndexedDB，保留原檔）
         */
        async syncAllLegacyToIndexedDB() {
            if (!db) return 0;
            let migratedCount = 0;
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key) continue;
                    try {
                        const existing = await withTimeout(db.getItem(key), IDB_TIMEOUT_MS);
                        if (existing === null || existing === undefined) {
                            const val = localStorage.getItem(key);
                            if (val !== null) {
                                await withTimeout(db.setItem(key, val), IDB_TIMEOUT_MS);
                                migratedCount++;
                            }
                        }
                    } catch (itemErr) {
                        console.warn('[AppStorage.syncAllLegacyToIndexedDB] 單鍵同步略過 (' + key + '):', itemErr);
                    }
                }
            } catch (err) {
                console.error('[AppStorage.syncAllLegacyToIndexedDB] 批次同步異常:', err);
            }
            return migratedCount;
        },

        /**
         * 讀取或重置智能備份異動追蹤狀態（含逾時與例外保護）
         */
        async getBackupTracker() {
            try {
                if (db) {
                    const raw = await withTimeout(db.getItem(BACKUP_TRACKER_KEY), IDB_TIMEOUT_MS);
                    if (raw) {
                        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
                    }
                }
            } catch (e) {
                console.warn('[AppStorage.getBackupTracker] 讀取追蹤器略過:', e);
            }
            return { changeCount: 0, lastChangedAt: null, lastChangedKey: '' };
        },

        async resetBackupTracker() {
            try {
                if (db) {
                    await withTimeout(db.setItem(BACKUP_TRACKER_KEY, JSON.stringify({
                        changeCount: 0,
                        lastChangedAt: null,
                        lastChangedKey: ''
                    })), IDB_TIMEOUT_MS);
                }
            } catch (e) {
                console.warn('[AppStorage.resetBackupTracker] 重置追蹤器略過:', e);
            }
        },

        /**
         * 取得儲存空間使用狀態統計（含 IndexedDB 與 localStorage 雙軌診斷）
         */
        async getStorageDiagnostics() {
            let estimate = null;
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    estimate = await navigator.storage.estimate();
                }
            } catch (e) {}
            const keys = await this.getAllKeys();
            const lsBytes = estimateLocalStorageBytes();
            return {
                engine: db ? 'IndexedDB (via localForage)' : 'localStorage Fallback',
                dualWriteMode: dualWriteMode,
                totalKeys: keys.length,
                usageBytes: estimate ? estimate.usage : null,
                quotaBytes: estimate ? estimate.quota : null,
                localStorageBytes: lsBytes,
                localStorageKB: (lsBytes / 1024).toFixed(1)
            };
        },

        async getStorageEstimate() {
            const diag = await this.getStorageDiagnostics();
            if (!diag || !diag.quotaBytes) return null;
            return {
                usageBytes: diag.usageBytes || 0,
                quotaBytes: diag.quotaBytes || 0,
                usageMB: ((diag.usageBytes || 0) / (1024 * 1024)).toFixed(2),
                quotaGB: ((diag.quotaBytes || 0) / (1024 * 1024 * 1024)).toFixed(1),
                localStorageKB: diag.localStorageKB
            };
        }
    };

    // 全域監聽 pageshow：當行動裝置從 bfcache 還原頁面時自動重建 IndexedDB 連線，13 個模組免改碼自動受益
    if (typeof window !== 'undefined') {
        window.addEventListener('pageshow', function (event) {
            if (event && event.persisted) {
                AppStorage.reconnect().catch(function () {});
            }
        });
    }

    global.AppStorage = AppStorage;
})(window);