# 本地執行資料

此目錄保存目前工作樹的長期資料：

- `app.yaml`：Port、共用角色資料庫路徑等啟動設定；修改後重啟生效。
- `history.sqlite`：角色／專案／Agent 等即時設定、近 30 天對話及前兩次即時設定版本。
- `history.sqlite-journal`：交易恢復檔，存在時須一併保留；舊版 WAL／SHM 檔也不可自行移除。
- `app.yaml.pre-sqlite.bak`：首次升級前的設定備份。
- `migration-source.json`：舊資料遷移來源紀錄。

只有此說明文件納入 Git；設定、資料庫及其他執行資料均忽略。日誌、PID、快取及臨時附件位於專案根目錄的 `3D-pet/instances/`。

共用角色參數改存 `characters.sqlite`；模型與動作檔位置不變。完整遷移及保留規則見 [README](../README.md#本地設定與歷史儲存)。
