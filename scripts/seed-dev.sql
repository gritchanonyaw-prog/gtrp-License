-- DEVELOPMENT SEED DATA ONLY. Do not run against staging or production.
-- Example plans from the product brief. Prices are placeholders (0) - set real prices in the admin dashboard.
INSERT INTO plans (id, code, name, price_minor, currency, billing_period, max_web_devices, max_ea_activations, max_trading_accounts, features_json, is_active, created_at, updated_at)
VALUES
  ('8d1f3b9e-0a0c-4f55-9d1a-000000000001', 'ANALYSIS', 'Analysis', 0, 'THB', 'monthly', 2, 0, 0,
   '{"web_access":true,"features":["advanced_charts","smc","volume_analysis"],"ea_products":[],"ea_platforms":[],"require_account_binding":false}', 1,
   '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z'),
  ('8d1f3b9e-0a0c-4f55-9d1a-000000000002', 'QUANT_PRO', 'Quant Pro', 0, 'THB', 'monthly', 2, 1, 1,
   '{"web_access":true,"features":["advanced_charts","ea_connector","smc","volume_analysis"],"ea_products":["gtrp_ea"],"ea_platforms":["mt4","mt5"],"require_account_binding":true}', 1,
   '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z'),
  ('8d1f3b9e-0a0c-4f55-9d1a-000000000003', 'QUANT_AUTO', 'Quant Auto', 0, 'THB', 'monthly', 3, 3, 2,
   '{"web_access":true,"features":["advanced_charts","ea_connector","smc","volume_analysis"],"ea_products":["gtrp_ea"],"ea_platforms":["mt4","mt5"],"require_account_binding":true}', 1,
   '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z')
ON CONFLICT (code) DO NOTHING;
