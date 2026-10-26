# 千張大戶集中度（手機版）

每週自動從集保結算所下載股權分散表，計算自選股的千張大戶持股比例和 1 週、4 週變化，用手機網頁查看。免金鑰、免費、不用開電腦。判讀規則沿用 [EquiLens](https://github.com/wakin61043/tw-trading-dashboard)（MIT）。

## 設定步驟（只要做一次）

1. 到 github.com 註冊並登入，按右上角 **+** → **New repository**，取個名字（例如 `big-holders`），選 **Public**，按 **Create repository**。
2. 在新 repo 頁面按 **uploading an existing file**，把這個資料夾裡的**所有檔案和資料夾**拖進去（包含 `.github` 資料夾），按 **Commit changes**。
   - 如果 `.github` 資料夾沒上傳成功（有些系統會隱藏它）：按 **Add file → Create new file**，檔名輸入 `.github/workflows/update.yml`，把該檔內容貼上存檔。
3. **Settings → Actions → General**，最下面 Workflow permissions 選 **Read and write permissions**，存檔。
4. **Actions** 分頁 → 左邊「更新千張大戶資料」→ **Run workflow**，等它變綠勾（約 1 分鐘）。
5. **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`、`/ (root)`，存檔。幾分鐘後頁面上方會出現網址，像 `https://你的帳號.github.io/big-holders/`。
6. 用手機打開那個網址 → 分享 → **加入主畫面**。

之後每週六、週一早上會自動更新，不用再管。

## 改自選股

在 GitHub 上打開 `watchlist.json` → 鉛筆圖示編輯 → 存檔。格式是 `"代號": "名稱"`，名稱可以留空字串，會自動抓。改完下次更新就會生效，想馬上看就到 Actions 再按一次 Run workflow。

## 注意

- 集保公開檔只有當週資料，所以要自己累積：第 2 週才有「1 週」變化，第 5 週才有「4 週」變化和全市場排行。
- 如果 Actions 出現紅叉、記錄寫「下載失敗」，可能是集保擋了 GitHub 的國外主機。這時改在自己電腦每週執行 `node scripts/update.mjs`（需 Node.js 22）再上傳 `data` 資料夾即可。
- 頁面是公開的（任何拿到網址的人都看得到你的自選股），資料本身是公開資訊。
- 判讀只描述籌碼變化方向，不代表股價會跟著走，不構成投資建議。
