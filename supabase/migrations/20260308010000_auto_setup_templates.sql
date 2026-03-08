-- Auto-setup: Update SEO/marketing templates to use auto-complete parameters
-- Users only need to input site_url; spreadsheet, sheet_name, email are auto-populated

-- Template 1: GA分析 → Claude SEO提案 → メール通知
UPDATE templates
SET parameters_schema = '{
  "properties": {
    "site_url": {
      "type": "string",
      "label": "分析対象サイトURL",
      "placeholder": "https://example.com"
    },
    "spreadsheet_id": {
      "type": "string",
      "label": "GAデータのスプレッドシートID",
      "hidden": true,
      "auto": "create_spreadsheet",
      "sheet_headers": ["日付", "ページURL", "PV", "UU", "直帰率", "CVR", "流入元"]
    },
    "sheet_name": {
      "type": "string",
      "label": "シート名",
      "hidden": true,
      "auto": "default",
      "default": "レポート"
    },
    "report_email": {
      "type": "string",
      "label": "レポート送信先メールアドレス",
      "hidden": true,
      "auto": "user_email"
    }
  }
}'::jsonb,
updated_at = now()
WHERE title = 'GA分析 → Claude SEO提案 → メール通知';

-- Template 2: GA分析データ → AI週次レポート → メール送信
UPDATE templates
SET parameters_schema = '{
  "properties": {
    "site_url": {
      "type": "string",
      "label": "分析対象サイトURL",
      "placeholder": "https://example.com"
    },
    "spreadsheet_id": {
      "type": "string",
      "label": "GAデータシートID",
      "hidden": true,
      "auto": "create_spreadsheet",
      "sheet_headers": ["日付", "ページURL", "PV", "UU", "直帰率", "CVR", "流入元"]
    },
    "sheet_name": {
      "type": "string",
      "label": "シート名",
      "hidden": true,
      "auto": "default",
      "default": "GAデータ"
    },
    "recipient_email": {
      "type": "string",
      "label": "レポート送信先",
      "hidden": true,
      "auto": "user_email"
    }
  }
}'::jsonb,
updated_at = now()
WHERE title = 'GA分析データ → AI週次レポート → メール送信';
