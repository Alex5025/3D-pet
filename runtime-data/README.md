# 運行資料

開發模式會將桌寵的執行參數寫入此目錄：

- `app.json`：格式版本、寵物順序與目前選擇的寵物。
- `pets/<UUID>.json`：每隻寵物各自的名稱、工作目錄、Codex Session ID、模型與角色參數。
- `pets/.trash/`：從設定頁移除的寵物設定，必要時可手動復原。

這些 JSON 檔由應用程式自動產生，屬於本機狀態，不應提交至版本控制。舊版 `runtime-data/config.json` 或根目錄 `config.json` 會在首次啟動時轉成第一隻寵物；舊檔不會被刪除。
