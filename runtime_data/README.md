# 本地執行資料

此目錄保存目前工作樹的長期資料：

- `app.yaml`：目前設定。
- `history.sqlite`：近 30 天對話及前兩次設定版本。
- `history.sqlite-wal`、`history.sqlite-shm`：SQLite 執行期間的配套檔案，請勿在程式運行中移除。
- `migration-source.json`：舊資料遷移來源紀錄。

只有此說明文件納入 Git；設定、資料庫及其他執行資料均忽略。日誌、PID、快取及臨時附件位於專案根目錄的 `3D-pet/instances/`。

系統共用角色與資產位置不變。完整遷移及保留規則見 [README](../README.md#本地設定與歷史儲存)。
