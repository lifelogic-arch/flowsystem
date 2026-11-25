/**
 * storage-core.js — 全域大容量儲存橋接核心 (IndexedDB + localForage + 智能備份異動追蹤)
 * 架構設計：
 * 1. 底層使用 IndexedDB (透過 localforage)，容量達數百 MB 至數 GB。
 * 2. 過渡期安全機制 (DUAL_WRITE_MODE，可透過首頁儲存診斷視窗動態切換)：
 *    - 讀取時：優先從 IndexedDB 讀取；若尚未搬遷，自動從 localStorage 複製一份進 IndexedDB（保留原檔不刪除）。
 *    - 寫入時：若啟用雙寫，先「同步」寫入 localStorage（防 beforeunload 非同步中斷），再非同步寫入 IndexedDB。
 * 3. 智能備份追蹤：自動偵測 13 大模組的實質資料異動次數，供首頁顯示智能備份提醒。
 * 4. 自動呼叫 navigator.storage.persist() 申請瀏覽器持久化儲存保護。
 */
(function (global) {
    'use strict';

    const DUAL_WRITE_PREF_KEY = 'LIFESTYLE_DUAL_WRITE_MODE_V1';
    const BACKUP_TRACKER_KEY = 'LIFESTYLE_BACKUP_TRACKER_V1';

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

    // 初始化獨立的 localForage 資料庫實例
    const db = (typeof localforage !== 'undefined')
        ? localforage.createInstance({
            name: 'LifeStyleArchitectureDB',
            storeName: 'financial_modules_store',
            description: '生活型態財務邏輯規劃系統大容量資料庫'
        })
        : null;

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
            'SESSION_'
        ];
        const ignoredExact = [
            'annual_goals_dark_mode',
            'etf_scale_ui_state_v4',
            'ETF_PORTFOLIO_UI_COLLAPSED_STATE_V2',
            'annual_asset_collapsed_fmt_v5'
        ];
        if (ignoredExact.includes(key)) return false;
        return !ignoredPrefixes.some(prefix => key.startsWith(prefix));
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
            const raw = await db.getItem(BACKUP_TRACKER_KEY);
            let tracker = { changeCount: 0, lastChangedAt: null, lastChangedKey: '' };
            if (raw) {
                tracker = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            }
            tracker.changeCount = (tracker.changeCount || 0) + 1;
            tracker.lastChangedAt = new Date().toISOString();
            tracker.lastChangedKey = key;
            await db.setItem(BACKUP_TRACKER_KEY, JSON.stringify(tracker));
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
            await requestPersistentStorage();
        },

        /**
         * 讀取資料（支援自動無痛複製搬遷：IndexedDB -> 若無則從 localStorage 複製進 IndexedDB）
         */
        async getItem(key) {
            try {
                if (db) {
                    const idbVal = await db.getItem(key);
                    if (idbVal !== null && idbVal !== undefined) {
                        return idbVal;
                    }
                }

                const legacyVal = localStorage.getItem(key);
                if (legacyVal !== null && legacyVal !== undefined) {
                    if (db) {
                        await db.setItem(key, legacyVal);
                    }
                    return legacyVal;
                }

                return null;
            } catch (err) {
                console.error(`[AppStorage.getItem] 讀取失敗 (${key}):`, err);
                return localStorage.getItem(key);
            }
        },

        /**
         * 寫入資料：
         * 若開啟雙寫模式，優先同步寫入 localStorage 以確保頁面關閉瞬間（beforeunload）資料不中斷，
         * 接著非同步寫入 IndexedDB 大容量資料庫。
         */
        async setItem(key, value) {
            const stringified = (typeof value === 'object' && value !== null)
                ? JSON.stringify(value)
                : String(value);

            if (dualWriteMode || !db) {
                try {
                    localStorage.setItem(key, stringified);
                } catch (quotaErr) {
                    console.warn(`[AppStorage.setItem] localStorage 容量已滿，改由 IndexedDB 承載 (${key}):`, quotaErr);
                }
            }

            let isActualChange = true;
            try {
                if (db) {
                    const prevVal = await db.getItem(key);
                    if (prevVal === stringified) {
                        isActualChange = false;
                    }
                    await db.setItem(key, stringified);
                }
            } catch (err) {
                console.error(`[AppStorage.setItem] IndexedDB 寫入失敗 (${key}):`, err);
            }

            if (isActualChange) {
                await recordDataMutation(key);
            }
        },

        /**
         * 移除單一資料鍵值
         */
        async removeItem(key) {
            try {
                localStorage.removeItem(key);
            } catch (err) {
                console.warn(`[AppStorage.removeItem] localStorage 移除異常 (${key}):`, err);
            }

            try {
                if (db) {
                    await db.removeItem(key);
                }
            } catch (err) {
                console.error(`[AppStorage.removeItem] IndexedDB 移除失敗 (${key}):`, err);
            }
        },

        /**
         * 取得所有已儲存的 Key 列表（合併 IndexedDB 與 localStorage）
         */
        async getAllKeys() {
            const keySet = new Set();
            try {
                if (db) {
                    const idbKeys = await db.keys();
                    idbKeys.forEach(k => keySet.add(k));
                }
            } catch (err) {
                console.error('[AppStorage.getAllKeys] IndexedDB 取得鍵值失敗:', err);
            }

            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) keySet.add(k);
            }
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
                    const existing = await db.getItem(key);
                    if (existing === null || existing === undefined) {
                        const val = localStorage.getItem(key);
                        if (val !== null) {
                            await db.setItem(key, val);
                            migratedCount++;
                        }
                    }
                }
            } catch (err) {
                console.error('[AppStorage.syncAllLegacyToIndexedDB] 批次同步異常:', err);
            }
            return migratedCount;
        },

        /**
         * 讀取或重置智能備份異動追蹤狀態
         */
        async getBackupTracker() {
            try {
                if (db) {
                    const raw = await db.getItem(BACKUP_TRACKER_KEY);
                    if (raw) {
                        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
                    }
                }
            } catch (e) {}
            return { changeCount: 0, lastChangedAt: null, lastChangedKey: '' };
        },

        async resetBackupTracker() {
            try {
                if (db) {
                    await db.setItem(BACKUP_TRACKER_KEY, JSON.stringify({
                        changeCount: 0,
                        lastChangedAt: null,
                        lastChangedKey: ''
                    }));
                }
            } catch (e) {}
        },

        /**
         * 取得儲存空間使用狀態統計（含 IndexedDB 與 localStorage 雙軌診斷）
         */
        async getStorageDiagnostics() {
            let estimate = null;
            if (navigator.storage && navigator.storage.estimate) {
                estimate = await navigator.storage.estimate();
            }
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

    global.AppStorage = AppStorage;
})(window);