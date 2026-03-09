-- Auto-setup: Update GA/SEO templates
-- spreadsheet_id, sheet_name はユーザー入力（既存のGAデータシートを指定）
-- report_email / recipient_email だけ auto: user_email で自動補完

-- Template 1: GA分析 → Claude SEO提案 → メール通知
UPDATE templates
SET parameters_schema = '{
  "properties": {
    "spreadsheet_id": {
      "type": "string",
      "label": "GAデータのスプレッドシートID",
      "placeholder": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
    },
    "sheet_name": {
      "type": "string",
      "label": "シート名",
      "placeholder": "レポート"
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
    "spreadsheet_id": {
      "type": "string",
      "label": "GAデータシートID",
      "placeholder": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
    },
    "sheet_name": {
      "type": "string",
      "label": "シート名",
      "placeholder": "GA_Weekly"
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
