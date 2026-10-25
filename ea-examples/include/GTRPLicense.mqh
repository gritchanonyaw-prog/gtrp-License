//+------------------------------------------------------------------+
//| GTRPLicense.mqh - GTRP License client for MQL4 and MQL5          |
//| Protocol v1. Mirrors ea-examples/reference-client/src/licenseClient.ts |
//|                                                                  |
//| SAFETY RULES                                                     |
//|  * Only a confirmed denial from the server (see IsConfirmedDenial)|
//|    blocks NEW entries. Network errors, timeouts, HTTP 5xx/429 and |
//|    malformed responses are temporary: the last lease keeps        |
//|    working until its offline_grace_until.                         |
//|  * Licensing NEVER blocks managing or closing existing positions. |
//|  * The license key is never printed to the log or the chart.     |
//|  * No DLLs. Uses the built-in WebRequest(); the server URL must   |
//|    be added in Tools > Options > Expert Advisors > "Allow         |
//|    WebRequest for listed URL".                                    |
//|  * This code cannot verify the lease signature (MQL has no       |
//|    built-in Ed25519). It relies on HTTPS to the server. A modified|
//|    EA binary can bypass any client-side check; see docs/SECURITY.md|
//+------------------------------------------------------------------+
#define GTRP_PROTOCOL_VERSION 1
#define GTRP_MAX_OFFLINE_GRACE_SEC (7 * 86400)

enum ENUM_GTRP_STATE
  {
   GTRP_STATE_UNKNOWN = 0,       // never validated in this session
   GTRP_STATE_VALID,             // last check succeeded
   GTRP_STATE_OFFLINE_GRACE,     // server unreachable, lease still valid
   GTRP_STATE_LAPSED,            // server unreachable and lease ran out
   GTRP_STATE_DENIED             // server confirmed: not allowed
  };

enum ENUM_GTRP_OUTCOME
  {
   GTRP_OK = 0,
   GTRP_DENIED,
   GTRP_TRANSIENT
  };

//+------------------------------------------------------------------+
//| Minimal JSON helpers for the fixed protocol v1 response shapes.  |
//| They find the first occurrence of "key": at or after `from`.      |
//+------------------------------------------------------------------+
int GTRP_JsonFindValue(const string json, const string key, const int from = 0)
  {
   string needle = "\"" + key + "\"";
   int p = StringFind(json, needle, from);
   if(p < 0)
      return -1;
   p += StringLen(needle);
   int n = StringLen(json);
   while(p < n && (StringGetCharacter(json, p) == ' ' || StringGetCharacter(json, p) == '\t' || StringGetCharacter(json, p) == '\r' || StringGetCharacter(json, p) == '\n'))
      p++;
   if(p >= n || StringGetCharacter(json, p) != ':')
      return -1;
   p++;
   while(p < n && (StringGetCharacter(json, p) == ' ' || StringGetCharacter(json, p) == '\t' || StringGetCharacter(json, p) == '\r' || StringGetCharacter(json, p) == '\n'))
      p++;
   return (p < n) ? p : -1;
  }

bool GTRP_JsonGetString(const string json, const string key, string &out, const int from = 0)
  {
   int p = GTRP_JsonFindValue(json, key, from);
   if(p < 0 || StringGetCharacter(json, p) != '"')
      return false;
   p++;
   string s = "";
   int n = StringLen(json);
   while(p < n)
     {
      ushort ch = StringGetCharacter(json, p);
      if(ch == '"')
        {
         out = s;
         return true;
        }
      if(ch == '\\' && p + 1 < n)
        {
         p++;
         ushort e = StringGetCharacter(json, p);
         if(e == 'n') s += "\n";
         else if(e == 't') s += "\t";
         else if(e == 'u') { s += "?"; p += 4; }   // non-ASCII escapes are not needed by the protocol
         else s += ShortToString(e);
        }
      else
         s += ShortToString(ch);
      p++;
     }
   return false;
  }

bool GTRP_JsonGetNumber(const string json, const string key, double &out, const int from = 0)
  {
   int p = GTRP_JsonFindValue(json, key, from);
   if(p < 0)
      return false;
   int start = p;
   int n = StringLen(json);
   while(p < n)
     {
      ushort ch = StringGetCharacter(json, p);
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == 'e' || ch == 'E' || ch == '+')
         p++;
      else
         break;
     }
   if(p == start)
      return false;
   out = StringToDouble(StringSubstr(json, start, p - start));
   return true;
  }

bool GTRP_JsonGetBool(const string json, const string key, bool &out, const int from = 0)
  {
   int p = GTRP_JsonFindValue(json, key, from);
   if(p < 0)
      return false;
   if(StringSubstr(json, p, 4) == "true") { out = true; return true; }
   if(StringSubstr(json, p, 5) == "false") { out = false; return true; }
   return false;
  }

string GTRP_JsonEscape(const string s)
  {
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", " ");
   StringReplace(r, "\r", " ");
   return r;
  }

//+------------------------------------------------------------------+
//| Time helpers (UTC, ISO 8601)                                     |
//+------------------------------------------------------------------+
string GTRP_ToIso(const datetime t)
  {
   string s = TimeToString(t, TIME_DATE | TIME_SECONDS);   // yyyy.mm.dd hh:mi:ss
   StringReplace(s, ".", "-");
   StringReplace(s, " ", "T");
   return s + "Z";
  }

// Returns 0 if the value is not an ISO 8601 UTC timestamp.
datetime GTRP_FromIso(const string iso)
  {
   if(StringLen(iso) < 20 || StringGetCharacter(iso, 10) != 'T' || StringGetCharacter(iso, StringLen(iso) - 1) != 'Z')
      return 0;
   string s = StringSubstr(iso, 0, 19);
   StringReplace(s, "-", ".");
   StringReplace(s, "T", " ");
   return StringToTime(s);
  }

string GTRP_RandomHex(const int len)
  {
   string hex = "0123456789abcdef";
   string s = "";
   for(int i = 0; i < len; i++)
      s += StringSubstr(hex, MathRand() % 16, 1);
   return s;
  }

// RFC 4122 version-4 shaped id. Used as a nonce, not as a secret.
string GTRP_NewRequestId()
  {
   string variant = StringSubstr("89ab", MathRand() % 4, 1);
   return GTRP_RandomHex(8) + "-" + GTRP_RandomHex(4) + "-4" + GTRP_RandomHex(3) + "-" + variant + GTRP_RandomHex(3) + "-" + GTRP_RandomHex(12);
  }

//+------------------------------------------------------------------+
//| License client                                                   |
//+------------------------------------------------------------------+
class CGTRPLicense
  {
private:
   string            m_baseUrl;
   string            m_key;
   string            m_product;
   string            m_platform;
   string            m_activationId;
   string            m_label;
   int               m_timeoutMs;
   int               m_deniedRetrySec;
   int               m_transientRetrySec;
   int               m_maxBackoffSec;
   int               m_backoffSec;

   ENUM_GTRP_STATE   m_state;
   string            m_lastCode;
   string            m_leaseToken;
   datetime          m_offlineGraceUntil;    // server (UTC) time
   datetime          m_nextCheckAt;          // local GMT time
   int               m_clockOffsetSec;       // server UTC - local TimeGMT()
   bool              m_requireAccount;
   bool              m_inGrace;

   // last response details
   int               m_httpStatus;
   string            m_body;
   string            m_errCode;
   string            m_errServerTime;

   datetime          ServerNow() { return TimeGMT() + m_clockOffsetSec; }

   string            AccountRef()
     {
      return AccountInfoString(ACCOUNT_SERVER) + ":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
     }

   string            Base(const string requestId)
     {
      return "\"protocol_version\":" + IntegerToString(GTRP_PROTOCOL_VERSION) +
             ",\"request_id\":\"" + requestId + "\"" +
             ",\"client_time\":\"" + GTRP_ToIso(ServerNow()) + "\"";
     }

   string            ActivationPayload(const string requestId, const bool withLabel)
     {
      string p = "{" + Base(requestId) +
                 ",\"license_key\":\"" + GTRP_JsonEscape(m_key) + "\"" +
                 ",\"product\":\"" + m_product + "\"" +
                 ",\"platform\":\"" + m_platform + "\"" +
                 ",\"activation_id\":\"" + m_activationId + "\"";
      if(m_requireAccount)
         p += ",\"account_ref\":\"" + GTRP_JsonEscape(AccountRef()) + "\"";
      if(withLabel && m_label != "")
         p += ",\"label\":\"" + GTRP_JsonEscape(m_label) + "\"";
      return p + "}";
     }

   bool              IsConfirmedDenial(const string code)
     {
      return code == "LICENSE_INVALID" || code == "LICENSE_NOT_STARTED" || code == "LICENSE_NOT_ACTIVE" ||
             code == "LICENSE_EXPIRED" || code == "LICENSE_SUSPENDED" || code == "LICENSE_REVOKED" ||
             code == "PRODUCT_NOT_ENTITLED" || code == "PLATFORM_NOT_ENTITLED" ||
             code == "ACTIVATION_LIMIT_REACHED" || code == "ACCOUNT_LIMIT_REACHED" ||
             code == "ACCOUNT_REF_REQUIRED" || code == "ACCOUNT_MISMATCH" ||
             code == "ACTIVATION_NOT_FOUND" || code == "ACTIVATION_REVOKED";
     }

   // One HTTPS POST. Returns the outcome; fills m_errCode / m_body.
   ENUM_GTRP_OUTCOME SendOnce(const string path, const string payload, const string requestId, const bool isDeactivate)
     {
      char data[];
      char result[];
      string resultHeaders;
      int n = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, n > 0 ? n - 1 : 0);   // drop the trailing NUL
      m_errCode = "";
      m_errServerTime = "";
      ResetLastError();
      m_httpStatus = WebRequest("POST", m_baseUrl + path, "Content-Type: application/json\r\n", m_timeoutMs, data, result, resultHeaders);
      if(m_httpStatus == -1)
        {
         int err = GetLastError();
         m_errCode = (err == 4014 || err == 4060) ? "WEBREQUEST_NOT_ALLOWED" : "NETWORK";
         if(m_errCode == "WEBREQUEST_NOT_ALLOWED")
            Print("GTRP License: add ", m_baseUrl, " to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.");
         return GTRP_TRANSIENT;
        }
      m_body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

      if(m_httpStatus == 200)
        {
         double pv = 0;
         string rid = "";
         if(!GTRP_JsonGetNumber(m_body, "protocol_version", pv) || (int)pv != GTRP_PROTOCOL_VERSION ||
            !GTRP_JsonGetString(m_body, "request_id", rid) || rid != requestId)
           {
            m_errCode = "MALFORMED";
            return GTRP_TRANSIENT;
           }
         string res = "";
         if(!GTRP_JsonGetString(m_body, "result", res))
           {
            m_errCode = "MALFORMED";
            return GTRP_TRANSIENT;
           }
         if(isDeactivate)
           {
            if(res == "deactivated")
               return GTRP_OK;
            m_errCode = "MALFORMED";
            return GTRP_TRANSIENT;
           }
         string token = "", graceIso = "", serverIso = "";
         double reval = 0;
         int leasePos = StringFind(m_body, "\"lease\"");
         if(res != "ok" || leasePos < 0 ||
            !GTRP_JsonGetString(m_body, "token", token, leasePos) ||
            !GTRP_JsonGetString(m_body, "offline_grace_until", graceIso) ||
            !GTRP_JsonGetString(m_body, "server_time", serverIso) ||
            !GTRP_JsonGetNumber(m_body, "revalidate_after_seconds", reval) ||
            GTRP_FromIso(graceIso) == 0 || GTRP_FromIso(serverIso) == 0 || reval < 30)
           {
            m_errCode = "MALFORMED";
            return GTRP_TRANSIENT;
           }
         return GTRP_OK;
        }

      // Error envelope: {"error":{"code":"...","message":"...","request_id":"...","retryable":bool,"server_time":"..."}}
      int errPos = StringFind(m_body, "\"error\"");
      string code = "";
      if(errPos < 0 || !GTRP_JsonGetString(m_body, "code", code, errPos))
         code = "HTTP_" + IntegerToString(m_httpStatus);
      m_errCode = code;
      if(errPos >= 0)
         GTRP_JsonGetString(m_body, "server_time", m_errServerTime, errPos);
      if(m_httpStatus >= 400 && m_httpStatus < 500 && IsConfirmedDenial(code))
         return GTRP_DENIED;
      return GTRP_TRANSIENT;
     }

   // Sends with one automatic retry for CLOCK_SKEW and for ACCOUNT_REF_REQUIRED.
   ENUM_GTRP_OUTCOME Call(const string path, const int kind)
     {
      bool retried = false;
      while(true)
        {
         string rid = GTRP_NewRequestId();
         string payload;
         if(kind == 0)
            payload = ActivationPayload(rid, true);                                   // activate
         else if(kind == 1)
            payload = ActivationPayload(rid, false);                                  // validate
         else if(kind == 2)
            payload = "{" + Base(rid) + ",\"lease_token\":\"" + m_leaseToken + "\",\"activation_id\":\"" + m_activationId + "\"}";  // refresh
         else
            payload = "{" + Base(rid) + ",\"license_key\":\"" + GTRP_JsonEscape(m_key) + "\",\"platform\":\"" + m_platform + "\",\"activation_id\":\"" + m_activationId + "\"}"; // deactivate
         ENUM_GTRP_OUTCOME r = SendOnce(path, payload, rid, kind == 3);
         if(retried)
            return r;
         if(r == GTRP_TRANSIENT && m_errCode == "CLOCK_SKEW" && m_errServerTime != "")
           {
            datetime st = GTRP_FromIso(m_errServerTime);
            if(st == 0)
               return r;
            m_clockOffsetSec = (int)(st - TimeGMT());
            retried = true;
            continue;
           }
         if(r == GTRP_DENIED && m_errCode == "ACCOUNT_REF_REQUIRED" && !m_requireAccount)
           {
            m_requireAccount = true;
            retried = true;
            continue;
           }
         return r;
        }
      return GTRP_TRANSIENT;
     }

   void              Apply(const ENUM_GTRP_OUTCOME r)
     {
      datetime now = TimeGMT();
      if(r == GTRP_OK)
        {
         string token = "", graceIso = "", serverIso = "";
         double reval = 1800;
         bool req = false, inGrace = false;
         int leasePos = StringFind(m_body, "\"lease\"");
         GTRP_JsonGetString(m_body, "token", token, leasePos);
         GTRP_JsonGetString(m_body, "offline_grace_until", graceIso);
         GTRP_JsonGetString(m_body, "server_time", serverIso);
         GTRP_JsonGetNumber(m_body, "revalidate_after_seconds", reval);
         GTRP_JsonGetBool(m_body, "require_account_binding", req);
         GTRP_JsonGetBool(m_body, "in_grace", inGrace);
         datetime serverTime = GTRP_FromIso(serverIso);
         m_clockOffsetSec = (int)(serverTime - now);
         datetime grace = GTRP_FromIso(graceIso);
         if(grace > serverTime + GTRP_MAX_OFFLINE_GRACE_SEC)
            grace = serverTime + GTRP_MAX_OFFLINE_GRACE_SEC;
         m_state = GTRP_STATE_VALID;
         m_lastCode = "";
         m_leaseToken = token;
         m_offlineGraceUntil = grace;
         m_requireAccount = req;
         m_inGrace = inGrace;
         m_backoffSec = m_transientRetrySec;
         m_nextCheckAt = now + (int)reval;
         return;
        }
      m_lastCode = m_errCode;
      if(r == GTRP_DENIED)
        {
         m_state = GTRP_STATE_DENIED;
         m_leaseToken = "";
         m_offlineGraceUntil = 0;
         m_nextCheckAt = now + m_deniedRetrySec;
         return;
        }
      // Transient: keep the previous lease. Never treat this as a revocation.
      if(m_state != GTRP_STATE_DENIED)
        {
         if(ServerNow() < m_offlineGraceUntil)
            m_state = GTRP_STATE_OFFLINE_GRACE;
         else if(m_state != GTRP_STATE_UNKNOWN)
            m_state = GTRP_STATE_LAPSED;
        }
      m_nextCheckAt = now + m_backoffSec;
      m_backoffSec = (int)MathMin(m_backoffSec * 2, m_maxBackoffSec);
     }

   // Loads or creates the per-installation id (MQL5/Files or MQL4/Files of this terminal).
   string            LoadActivationId()
     {
      string file = "GTRP\\activation_" + m_platform + ".id";
      string id = "";
      int h = FileOpen(file, FILE_READ | FILE_TXT | FILE_ANSI);
      if(h != INVALID_HANDLE)
        {
         id = FileReadString(h);
         FileClose(h);
        }
      if(StringLen(id) >= 16)
         return id;
      MathSrand((int)(GetTickCount() ^ (uint)TimeLocal() ^ (uint)(GetMicrosecondCount() & 0x7FFFFFFF)));
      id = m_platform + "_" + GTRP_RandomHex(24);
      h = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_ANSI);
      if(h != INVALID_HANDLE)
        {
         FileWriteString(h, id);
         FileClose(h);
        }
      return id;
     }

public:
                     CGTRPLicense()
     {
      m_state = GTRP_STATE_UNKNOWN;
      m_timeoutMs = 5000;
      m_deniedRetrySec = 900;
      m_transientRetrySec = 60;
      m_maxBackoffSec = 900;
      m_backoffSec = 60;
      m_offlineGraceUntil = 0;
      m_nextCheckAt = 0;
      m_clockOffsetSec = 0;
      m_requireAccount = false;
      m_inGrace = false;
     }

   void              Init(const string baseUrl, const string licenseKey, const string product, const string label)
     {
      m_baseUrl = baseUrl;
#ifdef __MQL5__
      m_key = licenseKey;
      StringTrimLeft(m_key);
      StringTrimRight(m_key);
#else
      m_key = StringTrimRight(StringTrimLeft(licenseKey));
#endif
      m_product = product;
      m_label = label;
#ifdef __MQL5__
      m_platform = "mt5";
#else
      m_platform = "mt4";
#endif
      m_activationId = LoadActivationId();
      MathSrand((int)(GetTickCount() ^ (uint)(GetMicrosecondCount() & 0x7FFFFFFF)));
     }

   // Call once after Init (from OnTimer, not OnInit, so the terminal is fully started).
   void              Start()
     {
      Apply(Call("/api/v1/licenses/activate", 0));
     }

   // Call from OnTimer(). Runs a check only when one is due.
   void              OnTimer()
     {
      if((m_state == GTRP_STATE_VALID || m_state == GTRP_STATE_OFFLINE_GRACE) && ServerNow() >= m_offlineGraceUntil)
         m_state = GTRP_STATE_LAPSED;
      if(TimeGMT() < m_nextCheckAt)
         return;
      Check();
     }

   void              Check()
     {
      if(m_leaseToken != "" && ServerNow() < m_offlineGraceUntil)
        {
         ENUM_GTRP_OUTCOME r = Call("/api/v1/licenses/refresh", 2);
         if(r == GTRP_TRANSIENT && (m_errCode == "LEASE_INVALID" || m_errCode == "LEASE_EXPIRED"))
           {
            m_leaseToken = "";
            Check();
            return;
           }
         Apply(r);
         return;
        }
      ENUM_GTRP_OUTCOME v = Call("/api/v1/licenses/validate", 1);
      if(v == GTRP_DENIED && m_errCode == "ACTIVATION_NOT_FOUND")
        {
         Start();
         return;
        }
      Apply(v);
     }

   bool              Deactivate()
     {
      ENUM_GTRP_OUTCOME r = Call("/api/v1/licenses/deactivate", 3);
      if(r == GTRP_OK || (r == GTRP_DENIED && m_errCode == "ACTIVATION_NOT_FOUND"))
        {
         m_state = GTRP_STATE_UNKNOWN;
         m_leaseToken = "";
         m_offlineGraceUntil = 0;
         return true;
        }
      return false;
     }

   // New entries only with a lease that has not run out.
   bool              CanOpenNewPositions()
     {
      return (m_state == GTRP_STATE_VALID || m_state == GTRP_STATE_OFFLINE_GRACE) && ServerNow() < m_offlineGraceUntil;
     }

   // Licensing never blocks stop-loss, take-profit, trailing, or closing positions.
   bool              CanManagePositions() { return true; }

   ENUM_GTRP_STATE   State() { return m_state; }
   string            LastCode() { return m_lastCode; }

   string            StatusText()
     {
      switch(m_state)
        {
         case GTRP_STATE_VALID:
            return m_inGrace ? "License OK (renewal grace period)" : "License OK";
         case GTRP_STATE_OFFLINE_GRACE:
            return "License server unreachable (" + m_lastCode + "). Offline until " + GTRP_ToIso(m_offlineGraceUntil);
         case GTRP_STATE_LAPSED:
            return "License not confirmed (" + m_lastCode + "). New entries paused; open positions are still managed.";
         case GTRP_STATE_DENIED:
            return "License denied: " + m_lastCode + ". New entries stopped; open positions are still managed.";
         default:
            return m_lastCode == "" ? "Checking license..." : "License not confirmed yet (" + m_lastCode + ")";
        }
     }
  };
//+------------------------------------------------------------------+
