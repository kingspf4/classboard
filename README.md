# 作業繳交看板＋聯絡簿（GitHub Pages ＋ Firebase 版）

一個網址，三個畫面：

| 畫面 | 網址 | 用途 |
| --- | --- | --- |
| 教師畫面 | `https://你的帳號.github.io/儲存庫名稱/` | 手機登記繳交、寫聯絡簿、控制大螢幕 |
| 大螢幕（作業看板） | 上面網址加 `?view=display` | 教室電腦，可用手機切換成聯絡簿 |
| 大螢幕（只顯示聯絡簿） | 上面網址加 `?view=diary` | 教室電腦，固定顯示聯絡簿 |

每台裝置第一次打開時，用老師的 Google 帳號登入一次，之後會記住。

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `index.html` | 畫面 |
| `data.js` | 讀寫 Firebase 的程式 |
| `firebase-config.js` | **要填**：你的 Firebase 專案設定 |
| `database.rules.json` | 資料庫規則範本（貼到 Firebase 主控台，不需要上傳到 GitHub 也可以） |

## 架設步驟

### 一、建立 Firebase 專案（約 10 分鐘）

1. 到 <https://console.firebase.google.com>，用老師的 Google 帳號登入，按「新增專案」。名稱自訂，Google Analytics 可以關閉。
2. **資料庫**：左側「建構」→「Realtime Database」→「建立資料庫」。位置選「新加坡（asia-southeast1）」，選「以鎖定模式啟動」。
3. **資料庫規則**：在 Realtime Database 點「規則」分頁，把 `database.rules.json` 的內容整段貼上，**把兩個 `老師的gmail@gmail.com` 換成你的 Gmail（全部小寫）**，按「發布」。
4. **Google 登入**：左側「建構」→「Authentication」→「開始使用」→「登入方式」→ 選「Google」→ 啟用 → 選支援電子郵件 →「儲存」。
5. **取得設定**：左上角齒輪「專案設定」→「一般」→ 最下方按網頁圖示 `</>` → 取個暱稱 →「註冊應用程式」（不用勾 Hosting）。畫面上的 `firebaseConfig = { … }` 就是要貼到 `firebase-config.js` 的內容。
   確認裡面有 `databaseURL` 這一行；沒有的話，是因為第 2 步還沒建立資料庫，建好後重新整理這一頁。

### 二、放上 GitHub（約 10 分鐘）

1. 到 <https://github.com> 登入，右上角「＋」→「New repository」。名稱例如 `classboard`，選 **Public**，按「Create repository」。
2. 在新的儲存庫頁面點「uploading an existing file」，把 `index.html`、`data.js`、`firebase-config.js`、`README.md` 拖進去，按「Commit changes」。
3. 點 `firebase-config.js` → 右上角鉛筆圖示編輯 → 把大括號裡的內容換成第一部分第 5 步複製的設定 →「Commit changes」。
4. 儲存庫上方「Settings」→ 左側「Pages」→ Source 選「Deploy from a branch」，Branch 選 `main`、資料夾 `/ (root)` →「Save」。
5. 等 1～2 分鐘，同一頁上方會出現網址，例如 `https://你的帳號.github.io/classboard/`。

### 三、讓 Firebase 允許這個網址登入

Firebase 主控台 →「Authentication」→「設定」→「授權網域」→「新增網域」→ 輸入 `你的帳號.github.io`（不含 `https://` 和後面的路徑）→「新增」。

### 四、開始使用

用手機打開網址 → 用 Google 帳號登入。第一次登入會自動建立預設資料（班級名稱、科目區塊、座位表），之後可以在「工具」→「班級設定」修改。

## 更新程式

在 GitHub 點要更新的檔案 → 鉛筆圖示 → 貼上新內容 →「Commit changes」，約 1 分鐘後網站自動更新，網址不變。或者用「Add file」→「Upload files」直接上傳覆蓋。

## 常見問題

- **登入後顯示「這個帳號沒有權限」**：資料庫規則裡的 email 和登入的帳號不同，或沒有用全部小寫。
- **按登入沒反應或出現 unauthorized-domain**：第三部分的授權網域還沒加，或打錯。
- **一直顯示「還沒有設定 Firebase」**：`firebase-config.js` 還是範本內容，或貼上時漏了大括號。
- **期末整理資料**：「工具」→「匯出紀錄」，下載的 CSV 可以用 Excel 或 Google 試算表開啟。
