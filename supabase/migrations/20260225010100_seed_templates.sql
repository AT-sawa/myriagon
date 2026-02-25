-- 011_seed_templates.sql
-- Insert starter workflow templates

insert into templates (title, description, category, services, parameters_schema, workflow_json, status) values

-- 1. Gmail → Sheets 自動転記
(
  'メール受信 → スプレッドシート自動転記',
  '受信メールの件名・送信者・日時をGoogle Sheetsに自動記録。問い合わせ管理や受注管理に最適です。',
  'データ連携',
  ARRAY['gmail', 'google_sheets'],
  '{"properties":{"spreadsheet_id":{"type":"string","label":"スプレッドシートID","placeholder":"1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"},"sheet_name":{"type":"string","label":"シート名","placeholder":"Sheet1"},"label_filter":{"type":"string","label":"対象ラベル (空欄で全メール)","placeholder":"INBOX"}}}'::jsonb,
  '{"nodes":[{"type":"gmail","name":"Gmail Trigger","parameters":{"event":"messageReceived"}},{"type":"google_sheets","name":"Sheets Append","parameters":{"operation":"append"}}]}'::jsonb,
  'active'
),

-- 2. Slack通知フロー
(
  'フォーム送信 → Slack通知',
  'Webhookでフォームデータを受け取り、整形してSlackチャンネルに自動通知します。',
  '通知',
  ARRAY['slack'],
  '{"properties":{"channel":{"type":"string","label":"Slackチャンネル","placeholder":"#general"},"mention":{"type":"string","label":"メンション (任意)","placeholder":"@channel"}}}'::jsonb,
  '{"nodes":[{"type":"webhook","name":"Webhook Trigger","parameters":{"httpMethod":"POST"}},{"type":"slack","name":"Slack Post","parameters":{"operation":"sendMessage"}}]}'::jsonb,
  'active'
),

-- 3. AI要約 → Slack投稿
(
  'ドキュメント要約 → Slack投稿',
  'Google Driveの新規ドキュメントをAIで自動要約し、Slackに投稿します。チームの情報共有を効率化。',
  'AI活用',
  ARRAY['google_drive', 'openai', 'slack'],
  '{"properties":{"drive_folder_id":{"type":"string","label":"Google DriveフォルダID","placeholder":"1a2b3c4d5e"},"slack_channel":{"type":"string","label":"投稿先チャンネル","placeholder":"#summaries"},"summary_length":{"type":"select","label":"要約の長さ","options":["短め (100文字)","標準 (300文字)","詳細 (500文字)"]}}}'::jsonb,
  '{"nodes":[{"type":"google_drive","name":"Drive Trigger","parameters":{"event":"fileCreated"}},{"type":"openai","name":"AI Summary","parameters":{"operation":"chat","model":"gpt-4"}},{"type":"slack","name":"Slack Post","parameters":{"operation":"sendMessage"}}]}'::jsonb,
  'active'
),

-- 4. リード管理自動化
(
  'フォーム → HubSpot リード自動登録',
  'Webフォームの送信データを自動でHubSpotのコンタクトに登録。営業チームへの通知もセット。',
  'CRM',
  ARRAY['hubspot', 'slack'],
  '{"properties":{"pipeline_id":{"type":"string","label":"HubSpotパイプラインID","placeholder":"default"},"notify_channel":{"type":"string","label":"通知チャンネル","placeholder":"#sales"}}}'::jsonb,
  '{"nodes":[{"type":"webhook","name":"Form Webhook","parameters":{"httpMethod":"POST"}},{"type":"hubspot","name":"Create Contact","parameters":{"operation":"create"}},{"type":"slack","name":"Notify Sales","parameters":{"operation":"sendMessage"}}]}'::jsonb,
  'active'
),

-- 5. 定期レポート自動生成
(
  '週次レポート自動生成 → メール送信',
  '毎週月曜にGoogle Sheetsのデータを集計し、AIがレポートを生成。指定メールアドレスに自動送信します。',
  'レポート',
  ARRAY['google_sheets', 'openai', 'gmail'],
  '{"properties":{"spreadsheet_id":{"type":"string","label":"スプレッドシートID","placeholder":"1BxiMVs..."},"data_range":{"type":"string","label":"データ範囲","placeholder":"A1:F100"},"recipient_email":{"type":"string","label":"送信先メール","placeholder":"team@example.com"},"report_style":{"type":"select","label":"レポートスタイル","options":["サマリー","詳細分析","グラフ付き"]}}}'::jsonb,
  '{"nodes":[{"type":"cron","name":"Weekly Trigger","parameters":{"rule":"0 9 * * 1"}},{"type":"google_sheets","name":"Read Data","parameters":{"operation":"read"}},{"type":"openai","name":"Generate Report","parameters":{"operation":"chat","model":"gpt-4"}},{"type":"gmail","name":"Send Report","parameters":{"operation":"sendEmail"}}]}'::jsonb,
  'active'
),

-- 6. カスタマーサポート自動応答
(
  'メール問い合わせ → AI自動応答ドラフト',
  '受信した問い合わせメールをAIが分析し、回答ドラフトを作成。下書きとして保存し、確認後に送信できます。',
  'AI活用',
  ARRAY['gmail', 'openai'],
  '{"properties":{"label_filter":{"type":"string","label":"対象ラベル","placeholder":"Support"},"language":{"type":"select","label":"応答言語","options":["日本語","英語","自動検出"]},"tone":{"type":"select","label":"トーン","options":["フォーマル","フレンドリー","技術的"]}}}'::jsonb,
  '{"nodes":[{"type":"gmail","name":"Gmail Trigger","parameters":{"event":"messageReceived","labelFilter":"Support"}},{"type":"openai","name":"AI Analyze & Draft","parameters":{"operation":"chat","model":"gpt-4"}},{"type":"gmail","name":"Save Draft","parameters":{"operation":"createDraft"}}]}'::jsonb,
  'active'
),

-- 7. SNS投稿自動化
(
  'Notion → SNS投稿スケジュール',
  'NotionのコンテンツカレンダーからSNS投稿を自動作成。AIがハッシュタグと投稿文を最適化します。',
  'マーケティング',
  ARRAY['notion', 'openai', 'slack'],
  '{"properties":{"database_id":{"type":"string","label":"NotionデータベースID","placeholder":"abc123..."},"post_channel":{"type":"string","label":"投稿通知チャンネル","placeholder":"#marketing"}}}'::jsonb,
  '{"nodes":[{"type":"notion","name":"Notion Trigger","parameters":{"event":"pageUpdated"}},{"type":"openai","name":"Optimize Post","parameters":{"operation":"chat"}},{"type":"slack","name":"Post Preview","parameters":{"operation":"sendMessage"}}]}'::jsonb,
  'active'
),

-- 8. 請求書処理自動化
(
  '請求書PDF → データ抽出 → Sheets記録',
  'メール添付の請求書PDFをAIが自動解析。金額・日付・取引先を抽出し、スプレッドシートに記録します。',
  'バックオフィス',
  ARRAY['gmail', 'openai', 'google_sheets'],
  '{"properties":{"spreadsheet_id":{"type":"string","label":"記録先スプレッドシートID","placeholder":"1BxiMVs..."},"label_filter":{"type":"string","label":"対象ラベル","placeholder":"Invoices"}}}'::jsonb,
  '{"nodes":[{"type":"gmail","name":"Gmail Trigger","parameters":{"event":"messageReceived","hasAttachment":true}},{"type":"openai","name":"AI Extract","parameters":{"operation":"chat","model":"gpt-4-vision"}},{"type":"google_sheets","name":"Record Data","parameters":{"operation":"append"}}]}'::jsonb,
  'active'
);
