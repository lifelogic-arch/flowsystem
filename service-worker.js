/**
 * service-worker.js — 生活型態 × 財務邏輯規劃系統 PWA 離線快取核心
 * 策略設計：
 * 1. Network-First（網路優先）：有網路時優先抓取 GitHub 最新版網頁與腳本並同步更新快取；
 *    離線（飛機上、地下室、無訊號環境）時自動無縫切換為本地快取版本。
 * 2. 跨網域 CDN 自動快取：自動攔截並快取 Tailwind CSS、Chart.js、Font Awesome、Google Fonts 與 localForage，
 *    確保離線狀態下所有圖表與排版皆可完整渲染。
 */
const CACHE_NAME = 'lifestyle-financial-pwa-v1.1';

const CORE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './favicon.png',
    './localforage.min.js',
    './storage-core.js',
    './1.lifestyle_生活型態軌跡評估表.html',
    './2.勞保老年給付試算表.html',
    './3.勞工退休金個人專戶金額試算與紀錄表.html',
    './4.個人現金流流水帳系統.html',
    './5.綜合所得稅預估與試算系統.html',
    './6.現金流量收支平衡表.html',
    './7.ETF 投資組合與單筆明細追蹤系統.html',
    './8.ETF 未來配息與收益試算系統.html',
    './9.股票質押試算與動態管理系統.html',
    './10.年度資產明細整合試算系統.html',
    './11.年度財務規劃甘特圖.html',
    './12.資產配置比例調整與年化報酬試算.html',
    './13.年度目標記錄規劃系統.html'
];

// 安裝階段：預先快取核心檔案（單一檔案失敗不阻斷整體安裝）
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await Promise.allSettled(
                CORE_ASSETS.map((url) =>
                    cache.add(encodeURI(url)).catch((err) => {
                        console.warn('[SW] 預快取略過:', url, err);
                    })
                )
            );
        })
    );
    self.skipWaiting();
});

// 啟用階段：清理舊版本快取
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_NAME) {
                        return caches.delete(name);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 請求攔截：Network-First 網路優先 + 離線快取備援（支援同源與外部 CDN）
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    event.respondWith(
        fetch(req)
            .then((networkResponse) => {
                if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(req, responseClone).catch(() => {});
                    });
                }
                return networkResponse;
            })
            .catch(async () => {
                const cachedResponse = await caches.match(req, { ignoreSearch: true });
                if (cachedResponse) {
                    return cachedResponse;
                }
                if (req.mode === 'navigate') {
                    const fallbackIndex = await caches.match('./index.html');
                    if (fallbackIndex) return fallbackIndex;
                }
                return new Response('目前處於離線狀態，且此資源尚未快取。', {
                    status: 503,
                    statusText: 'Offline'
                });
            })
    );
});