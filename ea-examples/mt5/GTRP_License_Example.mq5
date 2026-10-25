//+------------------------------------------------------------------+
//| GTRP_License_Example.mq5                                         |
//| Example: how a GTRP EA integrates the license client (MT5).      |
//| This file contains NO trading strategy. Replace the two hooks    |
//| ManageOpenPositions() and EntrySignal() with your EA's logic.     |
//|                                                                  |
//| Setup:                                                           |
//|  1. Copy ../include/GTRPLicense.mqh to <Data Folder>/MQL5/Include/|
//|  2. Tools > Options > Expert Advisors > tick "Allow WebRequest    |
//|     for listed URL" and add the server URL (InpLicenseServer).    |
//|  3. Compile in MetaEditor, attach to a chart, enter the key.     |
//+------------------------------------------------------------------+
#property copyright "GTRP"
#property version   "1.00"
#property strict

#include <GTRPLicense.mqh>

input string InpLicenseKey    = "";                             // License key (GTRP-XXXX-XXXX-XXXX-XXXX)
input string InpLicenseServer = "https://license.example.com";  // License server (HTTPS only)
input string InpDeviceLabel   = "";                             // Optional label shown to admins (e.g. "VPS-1")

const string GTRP_PRODUCT_ID = "gtrp_ea";   // must match a product in the customer's plan

CGTRPLicense g_license;
bool         g_started = false;

int OnInit()
  {
   if(StringFind(InpLicenseServer, "https://") != 0)
     {
      Alert("GTRP: the license server must use https://");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(StringLen(InpLicenseKey) < 10)
     {
      Alert("GTRP: enter your license key in the EA inputs.");
      return INIT_PARAMETERS_INCORRECT;
     }
   g_license.Init(InpLicenseServer, InpLicenseKey, GTRP_PRODUCT_ID, InpDeviceLabel);
   // First check runs from OnTimer, one second after start.
   EventSetTimer(1);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
   // Deactivate only when the user removes the EA on purpose, not on chart/timeframe changes or terminal shutdown.
   if(reason == REASON_REMOVE && !MQLInfoInteger(MQL_TESTER))
      g_license.Deactivate();
  }

void OnTimer()
  {
   if(MQLInfoInteger(MQL_TESTER))
      return;   // WebRequest is not available in the Strategy Tester
   if(!g_started)
     {
      g_started = true;
      EventKillTimer();
      EventSetTimer(60);
      g_license.Start();
     }
   else
      g_license.OnTimer();
   Comment("GTRP: ", g_license.StatusText());
  }

void OnTick()
  {
   // 1) ALWAYS manage existing positions, whatever the license state or network status.
   if(g_license.CanManagePositions())
      ManageOpenPositions();

   // 2) Open NEW positions only while the license is confirmed (or inside the bounded offline grace).
   bool licensed = MQLInfoInteger(MQL_TESTER) ? true : g_license.CanOpenNewPositions();
   if(licensed && EntrySignal())
     {
      // Place your order here (CTrade.Buy / CTrade.Sell ...).
     }
  }

//--- Strategy hooks (intentionally empty in this example) -----------
void ManageOpenPositions()
  {
   // Trailing stops, break-even, partial close, emergency close ...
  }

bool EntrySignal()
  {
   return false;
  }
//+------------------------------------------------------------------+
